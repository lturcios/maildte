import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenancy/tenant-context';
import { ListPartiesDto } from './dto/list-parties.dto';
import { UpdatePartyDefaultsDto } from './dto/update-party-defaults.dto';
import { DtePartyRow, PARTY_SELECT } from './purchase-book.projections';

export type PartyWithCounts = DtePartyRow & {
  _count: { emisorDocuments: number; receptorDocuments: number };
};

/**
 * Catálogo de emisores y receptores del tenant (Addendum 10, ADR-10.2).
 *
 * Alimenta los selects de filtro del panel y guarda los defaults Q–T que un
 * receptor aplica a todas sus compras.
 */
@Injectable()
export class PartiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PartiesService.name);
  }

  async findAll(ctx: TenantContext, dto: ListPartiesDto): Promise<PartyWithCounts[]> {
    const tenantId = this.requireTenantId(ctx);

    const where: Prisma.DtePartyWhereInput = { tenantId };
    if (dto.role === 'EMISOR') where.seenAsEmisor = true;
    else where.seenAsReceptor = true;

    if (dto.q) {
      const contains = dto.q.trim();
      if (contains.length > 0) {
        where.OR = [
          { nombre: { contains, mode: 'insensitive' } },
          { nombreComercial: { contains, mode: 'insensitive' } },
          { nit: { contains, mode: 'insensitive' } },
        ];
      }
    }

    return this.prisma.withTenant(tenantId, (tx) =>
      tx.dteParty.findMany({
        where,
        select: {
          ...PARTY_SELECT,
          _count: { select: { emisorDocuments: true, receptorDocuments: true } },
        },
        orderBy: { nombre: 'asc' },
        take: dto.limit,
      }),
    );
  }

  /**
   * Actualiza los defaults Q–T. No exige que la parte sea receptor: una parte
   * puede empezar como emisor y volverse receptor en otro documento, y guardar
   * el default por adelantado no rompe nada.
   */
  async updateDefaults(
    ctx: TenantContext,
    id: string,
    dto: UpdatePartyDefaultsDto,
  ): Promise<DtePartyRow> {
    const tenantId = this.requireTenantId(ctx);

    // Solo se escriben las claves presentes: un PATCH parcial no borra los
    // defaults que el usuario no mencionó.
    const data: Prisma.DtePartyUpdateInput = {};
    if ('defaultTipoOperacion' in dto) data.defaultTipoOperacion = dto.defaultTipoOperacion ?? null;
    if ('defaultClasificacion' in dto) data.defaultClasificacion = dto.defaultClasificacion ?? null;
    if ('defaultSector' in dto) data.defaultSector = dto.defaultSector ?? null;
    if ('defaultTipoCostoGasto' in dto) {
      data.defaultTipoCostoGasto = dto.defaultTipoCostoGasto ?? null;
    }

    const party = await this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.dteParty.findFirst({
        where: { id, tenantId },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException({
          error: 'DTE_PARTY_NOT_FOUND',
          message: 'Emisor o receptor no encontrado',
        });
      }
      return tx.dteParty.update({ where: { id }, data, select: PARTY_SELECT });
    });

    this.logger.info(
      { tenantId, partyId: id, actorId: ctx.actor.id },
      'Defaults del Anexo 3 del receptor actualizados',
    );
    return party;
  }

  private requireTenantId(ctx: TenantContext): string {
    if (!ctx.tenantId) {
      throw new ForbiddenException({
        error: 'FORBIDDEN_ROLE',
        message: 'SUPERADMIN no consulta el catálogo de partes de un tenant por esta ruta',
      });
    }
    return ctx.tenantId;
  }
}
