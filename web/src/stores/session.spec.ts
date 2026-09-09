import { apiGet } from '@/lib/api-client';
import type { DteParty, PurchaseBookCatalogs, SafeAccount } from '@/types/domain';

import { useAccountsStore } from './accounts-store';
import { useAuthStore } from './auth-store';
import { useDtePartiesStore } from './dte-parties-store';
import { usePurchaseBookCatalogsStore } from './purchase-book-catalogs-store';
import { endSession, resetTenantStores, startSession } from './session';
import { useUiStore } from './ui-store';

// Solo se sustituye el transporte: `ApiError` y el resto del cliente quedan
// reales, porque los stores hacen `error instanceof ApiError`.
vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return { ...actual, apiGet: vi.fn() };
});

const apiGetMock = vi.mocked(apiGet);

interface TenantFixture {
  receptores: DteParty[];
  accounts: SafeAccount[];
}

function buildParty(nombre: string): DteParty {
  return {
    id: `party-${nombre}`,
    nit: '06140101901011',
    nrc: '123456-7',
    nombre,
    nombreComercial: null,
    codActividad: null,
    descActividad: null,
    seenAsEmisor: false,
    seenAsReceptor: true,
    defaultTipoOperacion: null,
    defaultClasificacion: null,
    defaultSector: null,
    defaultTipoCostoGasto: null,
    _count: { emisorDocuments: 0, receptorDocuments: 3 },
  };
}

function buildAccount(alias: string): SafeAccount {
  return {
    id: `account-${alias}`,
    tenantId: `tenant-${alias}`,
    alias,
    email: `${alias}@example.com`,
    folderName: alias,
    providerId: null,
    provider: null,
    imapHost: 'imap.example.com',
    imapPort: 993,
    imapSecure: true,
    imapUser: `${alias}@example.com`,
    mailbox: 'INBOX',
    syncInterval: 15,
    syncFromDate: '2026-01-01T00:00:00.000Z',
    lastUid: 0,
    uidValidity: null,
    lastSyncAt: null,
    lastError: null,
    status: 'ACTIVA',
    deletedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const CATALOGS: PurchaseBookCatalogs = {
  tipoOperacion: [{ code: 1, label: 'Gravada' }],
  clasificacion: [],
  sector: [],
  tipoCostoGasto: [],
  tipoDocumento: [],
  claseDocumento: [],
  condicionOperacion: [],
  formaPago: [],
};

const TENANT_A: TenantFixture = {
  receptores: [buildParty('Wendy Cocar')],
  accounts: [buildAccount('wendy-cocar')],
};

const TENANT_B: TenantFixture = {
  receptores: [buildParty('Rosa Alvarez')],
  accounts: [buildAccount('rosa-alvarez')],
};

/** Responde cada endpoint con los datos del tenant indicado. */
function serveTenant(fixture: TenantFixture): void {
  apiGetMock.mockImplementation((path: string) => {
    if (path.startsWith('/purchase-book/parties')) {
      return Promise.resolve({ data: fixture.receptores });
    }
    if (path === '/accounts') {
      return Promise.resolve({ data: fixture.accounts });
    }
    if (path === '/purchase-book/catalogs') {
      return Promise.resolve({ data: CATALOGS });
    }
    return Promise.reject(new Error(`Endpoint no esperado en el test: ${path}`));
  });
}

/** Simula lo que hacen las vistas al montarse: pedir lo que todavía no tienen. */
async function mountViews(): Promise<void> {
  await useDtePartiesStore.getState().fetchParties('RECEPTOR');
  await useAccountsStore.getState().fetchAccounts();
  await usePurchaseBookCatalogsStore.getState().fetchCatalogs();
}

function receptorNames(): string[] {
  return useDtePartiesStore.getState().byRole.RECEPTOR.parties.map((party) => party.nombre);
}

function accountAliases(): string[] {
  return useAccountsStore.getState().accounts.map((account) => account.alias);
}

beforeEach(() => {
  apiGetMock.mockReset();
  resetTenantStores();
  useAuthStore.getState().logout();
  useUiStore.getState().setTheme('dark');
});

describe('resetTenantStores', () => {
  it('vacía el catálogo de partes y lo deja sin cargar, así el próximo fetchParties vuelve a pedir al servidor', async () => {
    serveTenant(TENANT_A);
    await useDtePartiesStore.getState().fetchParties('RECEPTOR');
    expect(receptorNames()).toEqual(['Wendy Cocar']);
    expect(useDtePartiesStore.getState().byRole.RECEPTOR.loaded).toBe(true);

    resetTenantStores();

    expect(receptorNames()).toEqual([]);
    expect(useDtePartiesStore.getState().byRole.RECEPTOR.loaded).toBe(false);

    serveTenant(TENANT_B);
    await useDtePartiesStore.getState().fetchParties('RECEPTOR');
    expect(apiGetMock).toHaveBeenCalledTimes(2);
    expect(receptorNames()).toEqual(['Rosa Alvarez']);
  });

  it('vacía las cuentas IMAP y las deja sin cargar, así el próximo fetchAccounts vuelve a pedir al servidor', async () => {
    serveTenant(TENANT_A);
    await useAccountsStore.getState().fetchAccounts();
    expect(accountAliases()).toEqual(['wendy-cocar']);
    expect(useAccountsStore.getState().loaded).toBe(true);

    resetTenantStores();

    expect(accountAliases()).toEqual([]);
    expect(useAccountsStore.getState().loaded).toBe(false);

    serveTenant(TENANT_B);
    await useAccountsStore.getState().fetchAccounts();
    expect(apiGetMock).toHaveBeenCalledTimes(2);
    expect(accountAliases()).toEqual(['rosa-alvarez']);
  });

  it('también vacía los catálogos del anexo, aunque no dependan del tenant: la regla vale para todo store alimentado por la API autenticada', async () => {
    serveTenant(TENANT_A);
    await usePurchaseBookCatalogsStore.getState().fetchCatalogs();
    expect(usePurchaseBookCatalogsStore.getState().catalogs).not.toBeNull();

    resetTenantStores();

    expect(usePurchaseBookCatalogsStore.getState().catalogs).toBeNull();
    expect(usePurchaseBookCatalogsStore.getState().loaded).toBe(false);
  });

  it('no toca las preferencias de interfaz, que son del dispositivo y no de la sesión', () => {
    useUiStore.getState().setTheme('light');

    resetTenantStores();

    expect(useUiStore.getState().theme).toBe('light');
  });

  it('descarta la respuesta de un fetch que quedó en vuelo cuando cambió la sesión', async () => {
    let resolveAccounts: (value: { data: SafeAccount[] }) => void = () => undefined;
    apiGetMock.mockImplementation(
      () =>
        new Promise<{ data: SafeAccount[] }>((resolve) => {
          resolveAccounts = resolve;
        }),
    );

    const pending = useAccountsStore.getState().fetchAccounts();
    resetTenantStores();
    resolveAccounts({ data: TENANT_A.accounts });
    await pending;

    expect(accountAliases()).toEqual([]);
    expect(useAccountsStore.getState().loaded).toBe(false);
  });
});

describe('cambio de sesión en la misma pestaña', () => {
  it('un logout seguido de un login deja los stores del tenant vacíos (caso reportado en producción)', async () => {
    // Sesión del tenant A: las vistas cachean receptores y cuentas.
    serveTenant(TENANT_A);
    startSession({ accessToken: 'access-a', refreshToken: 'refresh-a' });
    await mountViews();
    expect(receptorNames()).toEqual(['Wendy Cocar']);
    expect(accountAliases()).toEqual(['wendy-cocar']);

    // El operador cierra sesión y entra con otro tenant sin recargar la página.
    endSession();
    serveTenant(TENANT_B);
    startSession({ accessToken: 'access-b', refreshToken: 'refresh-b' });

    // Antes de que llegue su propio fetch, la sesión nueva no puede tener a
    // mano nada de la anterior para pintar.
    expect(receptorNames()).toEqual([]);
    expect(accountAliases()).toEqual([]);

    // Y al montar las vistas se vuelve a pedir, ahora con los datos del tenant B.
    await mountViews();
    expect(receptorNames()).toEqual(['Rosa Alvarez']);
    expect(accountAliases()).toEqual(['rosa-alvarez']);
  });

  it('un login sin logout previo (sesión reemplazada) también limpia el caché de la anterior', async () => {
    serveTenant(TENANT_A);
    startSession({ accessToken: 'access-a', refreshToken: 'refresh-a' });
    await mountViews();
    expect(receptorNames()).toEqual(['Wendy Cocar']);

    startSession({ accessToken: 'access-b', refreshToken: 'refresh-b' });

    expect(receptorNames()).toEqual([]);
    expect(accountAliases()).toEqual([]);
  });

  it('endSession borra las credenciales además de los datos del tenant', async () => {
    serveTenant(TENANT_A);
    startSession({ accessToken: 'access-a', refreshToken: 'refresh-a' });
    await mountViews();

    endSession();

    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useAuthStore.getState().refreshToken).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
  });
});
