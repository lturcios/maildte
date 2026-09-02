/**
 * Semilla idempotente del catálogo de perfiles de servicio de correo
 * (Addendum 09). Hace upsert por `key`, así que se puede re-ejecutar para
 * agregar proveedores nuevos o corregir un host sin tocar la base a mano.
 *
 * Uso:
 *   pnpm run seed:mail-providers
 *   pnpm run seed:mail-providers -- --link-existing
 *
 * `--link-existing` es un flag EXPLÍCITO de mantenimiento (regla de CLAUDE.md:
 * nada de migrar datos sin pedirlo): recorre las cuentas con providerId NULL y,
 * cuando su imapHost coincide exactamente con el de un perfil, las vincula.
 * Sin el flag, el script no toca ninguna cuenta.
 *
 * Conecta con APP_DATABASE_URL (rol restringido): mail_providers y
 * mail_provider_domains son catálogo global sin RLS, así que el rol de
 * aplicación puede escribirlas sin necesitar el owner de las migraciones.
 *
 * IMPORTANTE sobre los sufijos MX: solo se registran los que identifican al
 * servidor IMAP real. Los MX de gateways de filtrado (pphosted.com,
 * mimecast.com, barracudanetworks.com, messagelabs.com) NO se registran nunca:
 * indican por dónde pasa el correo entrante, no dónde se leen los buzones.
 */
import { PrismaClient } from '@prisma/client';

interface ProviderSeed {
  key: string;
  name: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  strict: boolean;
  sortOrder: number;
  notes?: string;
  helpUrl?: string;
  domains: string[];
  mxSuffixes: string[];
}

const PROVIDERS: ProviderSeed[] = [
  {
    key: 'gmail',
    name: 'Gmail / Google Workspace',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    imapSecure: true,
    strict: true,
    sortOrder: 10,
    notes:
      'Si la cuenta tiene verificación en dos pasos, la contraseña normal no sirve: hay que generar una contraseña de aplicación. En Google Workspace, el administrador debe tener IMAP habilitado.',
    helpUrl: 'https://support.google.com/accounts/answer/185833',
    domains: ['gmail.com', 'googlemail.com'],
    mxSuffixes: ['google.com', 'googlemail.com'],
  },
  {
    key: 'microsoft365',
    name: 'Microsoft 365 / Outlook / Hotmail',
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    imapSecure: true,
    strict: true,
    sortOrder: 20,
    notes:
      'Microsoft viene retirando la autenticación básica (usuario y contraseña) en IMAP a favor de OAuth2. Antes de usar este perfil, verificá con una cuenta real que la conexión funcione.',
    helpUrl:
      'https://support.microsoft.com/office/pop-imap-and-smtp-settings-8361e398-8af4-4e97-b147-6c6c4ac95353',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
    mxSuffixes: ['mail.protection.outlook.com'],
  },
  {
    key: 'yahoo',
    name: 'Yahoo Mail',
    imapHost: 'imap.mail.yahoo.com',
    imapPort: 993,
    imapSecure: true,
    strict: true,
    sortOrder: 30,
    notes: 'Requiere generar una contraseña de aplicación desde la seguridad de la cuenta.',
    helpUrl: 'https://help.yahoo.com/kb/SLN15241.html',
    domains: ['yahoo.com', 'yahoo.es', 'yahoo.com.mx', 'ymail.com'],
    mxSuffixes: ['yahoodns.net'],
  },
  {
    key: 'icloud',
    name: 'iCloud Mail',
    imapHost: 'imap.mail.me.com',
    imapPort: 993,
    imapSecure: true,
    strict: true,
    sortOrder: 40,
    notes: 'Requiere una contraseña específica de la app generada desde la cuenta de Apple.',
    helpUrl: 'https://support.apple.com/102654',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    mxSuffixes: ['icloud.com'],
  },
  {
    key: 'zoho',
    name: 'Zoho Mail',
    imapHost: 'imap.zoho.com',
    imapPort: 993,
    imapSecure: true,
    strict: false,
    sortOrder: 50,
    notes:
      'Hay que habilitar IMAP en la configuración de la cuenta. Con autenticación en dos pasos, se necesita una contraseña de aplicación.',
    helpUrl: 'https://www.zoho.com/mail/help/imap-access.html',
    domains: ['zoho.com', 'zohomail.com'],
    mxSuffixes: ['zoho.com', 'zohomail.com'],
  },
  {
    key: 'godaddy',
    name: 'GoDaddy (Professional Email)',
    imapHost: 'imap.secureserver.net',
    imapPort: 993,
    imapSecure: true,
    strict: false,
    sortOrder: 60,
    domains: [],
    mxSuffixes: ['secureserver.net'],
  },
  {
    key: 'namecheap',
    name: 'Namecheap Private Email',
    imapHost: 'mail.privateemail.com',
    imapPort: 993,
    imapSecure: true,
    strict: false,
    sortOrder: 70,
    domains: [],
    mxSuffixes: ['privateemail.com'],
  },
  {
    key: 'hostinger',
    name: 'Hostinger',
    imapHost: 'imap.hostinger.com',
    imapPort: 993,
    imapSecure: true,
    strict: false,
    sortOrder: 80,
    domains: [],
    mxSuffixes: ['hostinger.com'],
  },
  {
    key: 'rackspace',
    name: 'Rackspace Email',
    imapHost: 'secure.emailsrvr.com',
    imapPort: 993,
    imapSecure: true,
    strict: false,
    sortOrder: 90,
    domains: [],
    mxSuffixes: ['emailsrvr.com'],
  },
];

async function seedProviders(prisma: PrismaClient): Promise<void> {
  for (const seed of PROVIDERS) {
    const { domains, mxSuffixes, notes, helpUrl, ...fields } = seed;
    const data = { ...fields, notes: notes ?? null, helpUrl: helpUrl ?? null };

    const provider = await prisma.mailProvider.upsert({
      where: { key: seed.key },
      create: data,
      update: data,
      select: { id: true },
    });

    // Los dominios se agregan, nunca se borran: si el SUPERADMIN sumó uno a mano
    // desde el panel, re-ejecutar la semilla no se lo debe llevar puesto.
    for (const domain of domains) {
      await prisma.mailProviderDomain.upsert({
        where: { kind_domain: { kind: 'DOMAIN', domain } },
        create: { providerId: provider.id, domain, kind: 'DOMAIN' },
        update: { providerId: provider.id },
      });
    }
    for (const domain of mxSuffixes) {
      await prisma.mailProviderDomain.upsert({
        where: { kind_domain: { kind: 'MX_SUFFIX', domain } },
        create: { providerId: provider.id, domain, kind: 'MX_SUFFIX' },
        update: { providerId: provider.id },
      });
    }

    console.log(
      `Perfil ${seed.key} listo (${domains.length} dominio(s), ${mxSuffixes.length} sufijo(s) MX).`,
    );
  }
}

async function linkExistingAccounts(prisma: PrismaClient): Promise<void> {
  const providers = await prisma.mailProvider.findMany({
    select: { id: true, key: true, imapHost: true },
  });

  let linked = 0;
  for (const provider of providers) {
    // Solo cuentas sin perfil y con el host exactamente igual: un match parcial
    // cambiaría el endpoint efectivo de una cuenta que hoy funciona.
    const result = await prisma.emailAccount.updateMany({
      where: { providerId: null, imapHost: provider.imapHost },
      data: { providerId: provider.id },
    });
    if (result.count > 0) {
      console.log(`  ${result.count} cuenta(s) vinculada(s) a ${provider.key}.`);
      linked += result.count;
    }
  }

  const remaining = await prisma.emailAccount.count({ where: { providerId: null } });
  console.log(
    `Vinculación terminada: ${linked} cuenta(s) vinculada(s), ${remaining} quedan como servidor personalizado.`,
  );
}

async function main(): Promise<void> {
  const databaseUrl = process.env.APP_DATABASE_URL;
  if (!databaseUrl) {
    console.error('Falta la variable de entorno APP_DATABASE_URL.');
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });

  try {
    await seedProviders(prisma);

    if (process.argv.includes('--link-existing')) {
      console.log('\n--link-existing: vinculando cuentas existentes por coincidencia de host…');
      await linkExistingAccounts(prisma);
    } else {
      console.log(
        '\nCuentas existentes sin tocar. Para vincularlas por host: pnpm run seed:mail-providers -- --link-existing',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('Error inesperado al sembrar el catálogo de servicios de correo:', err);
  process.exitCode = 1;
});
