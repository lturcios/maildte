import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DomainMatchKind, Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { isPrismaUniqueViolation } from '../prisma/prisma-errors';
import { REDIS_CONNECTION } from '../redis/redis.constants';
import { TenantContext } from '../common/tenancy/tenant-context';
import { ImapEndpoint } from '../sync/imap/resolve-imap-endpoint';
import { CreateMailProviderDto } from './dto/create-mail-provider.dto';
import { UpdateMailProviderDto } from './dto/update-mail-provider.dto';
import { MailProviderDomainDto } from './dto/mail-provider-domain.dto';
import { probeImapEndpoint, ProbeResult } from './imap-probe';
import { domainOfEmail, lookupMxExchanges, matchesMxSuffix } from './mx-lookup';

const PROVIDER_SELECT = {
  id: true,
  key: true,
  name: true,
  imapHost: true,
  imapPort: true,
  imapSecure: true,
  defaultMailbox: true,
  strict: true,
  notes: true,
  helpUrl: true,
  active: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  domains: {
    select: { id: true, domain: true, kind: true },
    orderBy: [{ kind: 'asc' }, { domain: 'asc' }],
  },
} satisfies Prisma.MailProviderSelect;

type MailProviderView = Prisma.MailProviderGetPayload<{ select: typeof PROVIDER_SELECT }>;

/** Orden estable del catálogo: primero lo curado, después alfabético. */
const PROVIDER_ORDER: Prisma.MailProviderOrderByWithRelationInput[] = [
  { sortOrder: 'asc' },
  { name: 'asc' },
];

/**
 * Cómo se llegó al perfil sugerido:
 * - DOMAIN: el dominio del correo está en el catálogo (gmail.com).
 * - MX: el dominio es propio, pero su MX apunta al proveedor (Workspace, M365).
 * - null: no se pudo inferir; el usuario elige a mano o carga un servidor propio.
 */
export type ProviderMatchSource = 'DOMAIN' | 'MX' | null;

export interface ResolvedProvider {
  provider: MailProviderView | null;
  source: ProviderMatchSource;
}

/** Caché del resultado DNS, no del perfil resuelto — ver resolveByEmail(). */
const MX_CACHE_PREFIX = 'mx:';
const MX_CACHE_TTL_SECONDS = 24 * 60 * 60;
const MX_CACHE_EMPTY_TTL_SECONDS = 60 * 60;

export interface MailProviderUsage {
  /** Todas las cuentas vinculadas, incluidas las de soft delete. */
  accounts: number;
  /** Solo las cuentas vivas (deletedAt NULL). */
  activeAccounts: number;
  /** Cuentas con soft delete: bloquean el borrado igual que las vivas. */
  deletedAccounts: number;
  /** Organizaciones distintas con al menos una cuenta vinculada. */
  tenants: number;
}

const PROVIDER_NOT_FOUND = {
  error: 'PROVIDER_NOT_FOUND',
  message: 'Servicio de correo no encontrado',
};
const PROVIDER_KEY_EXISTS = {
  error: 'PROVIDER_KEY_EXISTS',
  message: 'Ya existe un servicio de correo con esa clave',
};
const PROVIDER_DOMAIN_EXISTS = {
  error: 'PROVIDER_DOMAIN_EXISTS',
  message: 'Alguno de los dominios ya está asignado a otro servicio de correo',
};

@Injectable()
export class MailProvidersService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MailProvidersService.name);
  }

  /**
   * Sugiere el perfil para una dirección de correo (ADR-09.3). Primero busca el
   * dominio exacto en el catálogo; si no está, consulta el registro MX, que es
   * lo que resuelve el caso real de la mayoría de las PYMEs: dominio propio
   * sobre Google Workspace o Microsoft 365.
   *
   * Es una SUGERENCIA, nunca una imposición: el usuario siempre puede cambiar el
   * perfil o cargar un servidor personalizado. Por eso ningún camino de error
   * propaga: todo termina en `{ provider: null, source: null }`.
   */
  async resolveByEmail(email: string): Promise<ResolvedProvider> {
    const domain = domainOfEmail(email);
    if (!domain) {
      return { provider: null, source: null };
    }

    const exact = await this.prisma.mailProviderDomain.findFirst({
      where: { kind: 'DOMAIN', domain, provider: { active: true } },
      select: { provider: { select: PROVIDER_SELECT } },
    });
    if (exact) {
      return { provider: exact.provider, source: 'DOMAIN' };
    }

    return this.resolveByMx(domain);
  }

  private async resolveByMx(domain: string): Promise<ResolvedProvider> {
    // La tabla de sufijos tiene decenas de filas: se traen todas una vez y el
    // match por sufijo se hace en memoria. En SQL habría que invertir el
    // endsWith y no se podría usar índice igual.
    const suffixes = await this.prisma.mailProviderDomain.findMany({
      where: { kind: 'MX_SUFFIX', provider: { active: true } },
      select: { domain: true, provider: { select: PROVIDER_SELECT } },
    });
    if (suffixes.length === 0) {
      return { provider: null, source: null };
    }

    const exchanges = await this.cachedMxExchanges(domain);

    // Se respeta la prioridad del MX: el primer servidor del dominio manda.
    for (const exchange of exchanges) {
      const hit = suffixes.find((row) => matchesMxSuffix(exchange, row.domain));
      if (hit) {
        return { provider: hit.provider, source: 'MX' };
      }
    }
    return { provider: null, source: null };
  }

  /**
   * Cachea la RESPUESTA DNS, no el perfil resuelto: si el SUPERADMIN agrega un
   * sufijo MX nuevo al catálogo, el match se recalcula al instante en vez de
   * quedar congelado 24 h. Lo caro y externo es el DNS; el match es en memoria.
   *
   * Un Redis caído no rompe nada: se cae a la consulta DNS directa.
   */
  private async cachedMxExchanges(domain: string): Promise<string[]> {
    const key = `${MX_CACHE_PREFIX}${domain}`;

    try {
      const cached = await this.redis.get(key);
      if (cached !== null) {
        const parsed: unknown = JSON.parse(cached);
        if (Array.isArray(parsed)) {
          return parsed.filter((entry): entry is string => typeof entry === 'string');
        }
      }
    } catch (err) {
      this.logger.warn({ err, domain }, 'No se pudo leer la caché de MX; se consulta DNS');
    }

    const exchanges = await lookupMxExchanges(domain);

    try {
      // TTL corto para el resultado vacío: si el cliente acaba de configurar su
      // dominio, no queremos negarle la detección por 24 h.
      const ttl = exchanges.length > 0 ? MX_CACHE_TTL_SECONDS : MX_CACHE_EMPTY_TTL_SECONDS;
      await this.redis.set(key, JSON.stringify(exchanges), 'EX', ttl);
    } catch (err) {
      this.logger.warn({ err, domain }, 'No se pudo escribir la caché de MX');
    }

    return exchanges;
  }

  /** Catálogo visible en el alta de cuentas: solo perfiles habilitados. */
  findAllActive(): Promise<MailProviderView[]> {
    return this.prisma.mailProvider.findMany({
      where: { active: true },
      select: PROVIDER_SELECT,
      orderBy: PROVIDER_ORDER,
    });
  }

  /** Catálogo completo para el panel de SUPERADMIN: incluye los deshabilitados. */
  findAllForAdmin(): Promise<MailProviderView[]> {
    return this.prisma.mailProvider.findMany({
      select: PROVIDER_SELECT,
      orderBy: PROVIDER_ORDER,
    });
  }

  async findOne(id: string): Promise<MailProviderView> {
    const provider = await this.prisma.mailProvider.findUnique({
      where: { id },
      select: PROVIDER_SELECT,
    });
    if (!provider) {
      throw new NotFoundException(PROVIDER_NOT_FOUND);
    }
    return provider;
  }

  async create(dto: CreateMailProviderDto, ctx: TenantContext): Promise<MailProviderView> {
    try {
      const created = await this.prisma.mailProvider.create({
        data: {
          key: dto.key,
          name: dto.name,
          imapHost: dto.imapHost,
          imapPort: dto.imapPort,
          imapSecure: dto.imapSecure,
          ...(dto.defaultMailbox !== undefined ? { defaultMailbox: dto.defaultMailbox } : {}),
          ...(dto.strict !== undefined ? { strict: dto.strict } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.helpUrl !== undefined ? { helpUrl: dto.helpUrl } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          ...(dto.domains !== undefined
            ? { domains: { create: this.toDomainRows(dto.domains) } }
            : {}),
        },
        select: PROVIDER_SELECT,
      });

      this.logger.info(
        { providerId: created.id, key: created.key, actorId: ctx.actor.id },
        'Servicio de correo creado',
      );
      return created;
    } catch (err) {
      throw this.mapWriteError(err);
    }
  }

  /**
   * Cambiar imapHost/imapPort/imapSecure de un perfil en uso es una acción de
   * producción: por la referencia viva (ADR-09.1) impacta en caliente a todos
   * los tenants vinculados en su siguiente ronda de sincronización. Por eso
   * exige `confirmAffectedAccounts` con el número exacto de cuentas.
   */
  async update(
    id: string,
    dto: UpdateMailProviderDto,
    ctx: TenantContext,
  ): Promise<MailProviderView> {
    const existing = await this.findOne(id);

    const endpointChanged =
      (dto.imapHost !== undefined && dto.imapHost !== existing.imapHost) ||
      (dto.imapPort !== undefined && dto.imapPort !== existing.imapPort) ||
      (dto.imapSecure !== undefined && dto.imapSecure !== existing.imapSecure);

    if (endpointChanged) {
      const usage = await this.usage(id);
      if (usage.accounts > 0 && dto.confirmAffectedAccounts !== usage.accounts) {
        throw new ConflictException({
          error: 'PROVIDER_ENDPOINT_CONFIRM_REQUIRED',
          message:
            `Este cambio afecta a ${usage.accounts} cuenta(s) de ${usage.tenants} organización(es) ` +
            'en su próxima sincronización. Confirmá enviando confirmAffectedAccounts con ese número exacto.',
        });
      }
      this.logger.warn(
        {
          providerId: id,
          key: existing.key,
          actorId: ctx.actor.id,
          affectedAccounts: usage.accounts,
          affectedTenants: usage.tenants,
          from: {
            imapHost: existing.imapHost,
            imapPort: existing.imapPort,
            imapSecure: existing.imapSecure,
          },
          to: {
            imapHost: dto.imapHost ?? existing.imapHost,
            imapPort: dto.imapPort ?? existing.imapPort,
            imapSecure: dto.imapSecure ?? existing.imapSecure,
          },
        },
        'Cambio de endpoint de un servicio de correo en uso',
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // `domains` presente reemplaza la lista completa; ausente no la toca.
        if (dto.domains !== undefined) {
          await tx.mailProviderDomain.deleteMany({ where: { providerId: id } });
          await tx.mailProviderDomain.createMany({
            data: this.toDomainRows(dto.domains).map((row) => ({ ...row, providerId: id })),
          });
        }

        return tx.mailProvider.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.imapHost !== undefined ? { imapHost: dto.imapHost } : {}),
            ...(dto.imapPort !== undefined ? { imapPort: dto.imapPort } : {}),
            ...(dto.imapSecure !== undefined ? { imapSecure: dto.imapSecure } : {}),
            ...(dto.defaultMailbox !== undefined ? { defaultMailbox: dto.defaultMailbox } : {}),
            ...(dto.strict !== undefined ? { strict: dto.strict } : {}),
            ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
            ...(dto.helpUrl !== undefined ? { helpUrl: dto.helpUrl } : {}),
            ...(dto.active !== undefined ? { active: dto.active } : {}),
            ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          },
          select: PROVIDER_SELECT,
        });
      });
    } catch (err) {
      throw this.mapWriteError(err);
    }
  }

  /**
   * Solo se puede borrar un perfil que no usa NINGUNA cuenta. La FK
   * `onDelete: Restrict` es el respaldo en base; este chequeo existe para dar un
   * mensaje que se entienda, incluida la parte contraintuitiva: las cuentas
   * eliminadas por soft delete conservan su providerId y también bloquean.
   */
  async remove(id: string, ctx: TenantContext): Promise<void> {
    const provider = await this.findOne(id);
    const usage = await this.usage(id);

    if (usage.accounts > 0) {
      const detalleBorradas =
        usage.deletedAccounts > 0
          ? ` (${usage.deletedAccounts} de ellas eliminadas, que conservan el vínculo y también impiden el borrado)`
          : '';
      throw new ConflictException({
        error: 'PROVIDER_IN_USE',
        message:
          `No se puede borrar: ${usage.accounts} cuenta(s) usan este servicio${detalleBorradas}. ` +
          'Para retirarlo del alta de cuentas sin romper las existentes, deshabilitalo con active: false.',
      });
    }

    await this.prisma.mailProvider.delete({ where: { id } });
    this.logger.info(
      { providerId: id, key: provider.key, actorId: ctx.actor.id },
      'Servicio de correo eliminado',
    );
  }

  /**
   * Conteo de uso de TODOS los perfiles, a través de todos los tenants.
   *
   * `email_accounts` tiene RLS FORCE con una policy de igualdad contra
   * `app.tenant_id`, así que una consulta sin tenant en contexto devuelve CERO
   * filas — no un error. Por eso no se puede contar de una sola vez: hay que
   * recorrer los tenants y agrupar dentro de withTenant() en cada uno.
   *
   * Se agrupa por providerId en vez de contar perfil por perfil: así el costo es
   * 2 consultas por organización, no 2 × perfiles × organizaciones. Es lo que
   * permite que la pantalla de administración muestre el uso de toda la tabla
   * sin degradarse cuando crezcan los tenants.
   *
   * Debilitar la policy para ahorrarse el recorrido abriría una fuga de datos
   * entre tenants: no vale la pena.
   */
  async usageAll(): Promise<Record<string, MailProviderUsage>> {
    const tenants = await this.prisma.tenant.findMany({ select: { id: true } });
    const usageByProvider: Record<string, MailProviderUsage> = {};

    const bucketFor = (providerId: string): MailProviderUsage => {
      usageByProvider[providerId] ??= {
        accounts: 0,
        activeAccounts: 0,
        deletedAccounts: 0,
        tenants: 0,
      };
      return usageByProvider[providerId];
    };

    for (const tenant of tenants) {
      const [totals, actives] = await this.prisma.withTenant(tenant.id, (tx) =>
        Promise.all([
          tx.emailAccount.groupBy({
            by: ['providerId'],
            where: { tenantId: tenant.id, providerId: { not: null } },
            _count: { _all: true },
          }),
          tx.emailAccount.groupBy({
            by: ['providerId'],
            where: { tenantId: tenant.id, providerId: { not: null }, deletedAt: null },
            _count: { _all: true },
          }),
        ]),
      );

      const activeByProvider = new Map(
        actives.map((row) => [row.providerId, row._count._all] as const),
      );

      for (const row of totals) {
        if (row.providerId === null) {
          continue;
        }
        const active = activeByProvider.get(row.providerId) ?? 0;
        const bucket = bucketFor(row.providerId);
        bucket.accounts += row._count._all;
        bucket.activeAccounts += active;
        bucket.deletedAccounts += row._count._all - active;
        bucket.tenants += 1;
      }
    }

    return usageByProvider;
  }

  /**
   * Uso de un perfil puntual. Delega en usageAll() a propósito: una sola
   * implementación del recorrido evita que el conteo del guard de edición y el
   * de la pantalla de administración puedan divergir.
   */
  async usage(providerId: string): Promise<MailProviderUsage> {
    const all = await this.usageAll();
    return all[providerId] ?? { accounts: 0, activeAccounts: 0, deletedAccounts: 0, tenants: 0 };
  }

  /** Alcance del endpoint del perfil, sin credenciales (ver imap-probe.ts). */
  async probe(id: string): Promise<ProbeResult> {
    const provider = await this.findOne(id);
    const endpoint: ImapEndpoint = {
      imapHost: provider.imapHost,
      imapPort: provider.imapPort,
      imapSecure: provider.imapSecure,
    };
    return probeImapEndpoint(endpoint);
  }

  /** Normaliza a minúsculas: la unicidad (kind, domain) es sensible a mayúsculas. */
  private toDomainRows(
    domains: MailProviderDomainDto[],
  ): { domain: string; kind: DomainMatchKind }[] {
    return domains.map((entry) => ({
      domain: entry.domain.trim().toLowerCase(),
      kind: entry.kind,
    }));
  }

  private mapWriteError(err: unknown): unknown {
    if (isPrismaUniqueViolation(err, 'key')) {
      return new ConflictException(PROVIDER_KEY_EXISTS);
    }
    if (isPrismaUniqueViolation(err, 'domain')) {
      return new ConflictException(PROVIDER_DOMAIN_EXISTS);
    }
    return err;
  }
}
