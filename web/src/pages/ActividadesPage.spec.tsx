import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import userEvent from '@testing-library/user-event';

import { useDtePartiesStore } from '@/stores/dte-parties-store';
import { usePurchaseActivitiesStore } from '@/stores/purchase-activities-store';
import { ActividadesPage } from './ActividadesPage';

const RECEPTOR_ID = '22222222-2222-2222-2222-222222222222';

/** La pagina tiene un <Link> de vuelta al libro: sin Router, React Router revienta. */
function EnRouter() {
  return (
    <MemoryRouter>
      <ActividadesPage />
    </MemoryRouter>
  );
}

vi.mock('@/stores/dte-parties-store', () => ({ useDtePartiesStore: vi.fn() }));
vi.mock('@/stores/purchase-activities-store', () => ({ usePurchaseActivitiesStore: vi.fn() }));

// El diálogo real pide la propuesta al montar; acá solo interesa SI se monta.
vi.mock('@/components/purchase-book/ActivitySeedDialog', () => ({
  ActivitySeedDialog: () => <div data-testid="seed-dialog" />,
}));

/** Los componentes leen con selectores, así que el mock los aplica a un estado falso. */
function mockStores(activityState: Record<string, unknown> = {}) {
  vi.mocked(useDtePartiesStore).mockImplementation(((selector: unknown) =>
    (selector as (s: unknown) => unknown)({
      byRole: {
        RECEPTOR: {
          parties: [{ id: RECEPTOR_ID, nombre: 'Wendy Cocar', nit: '0614' }],
          loading: false,
          loaded: true,
        },
      },
      fetchParties: vi.fn(),
    })) as unknown as typeof useDtePartiesStore);

  vi.mocked(usePurchaseActivitiesStore).mockImplementation(((selector: unknown) =>
    (selector as (s: unknown) => unknown)({
      receptorId: RECEPTOR_ID,
      activities: [],
      mappings: [],
      loading: false,
      error: null,
      load: vi.fn(),
      createActivity: vi.fn(),
      updateActivity: vi.fn(),
      deactivateActivity: vi.fn(),
      removeActivity: vi.fn(),
      setSupplierDefault: vi.fn(),
      clearSupplierDefault: vi.fn(),
      ...activityState,
    })) as unknown as typeof usePurchaseActivitiesStore);
}

describe('ActividadesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStores();
  });

  it('el botón de siembra abre el diálogo', async () => {
    const user = userEvent.setup();
    render(<EnRouter />);

    expect(screen.queryByTestId('seed-dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Sembrar desde las compras/i }));

    expect(screen.getByTestId('seed-dialog')).toBeInTheDocument();
  });

  /**
   * El diálogo colgaba del mismo guard que el resto de la pantalla
   * (`!loading && !error && receptor`). Cualquiera de los tres que se pusiera
   * falso lo desmontaba en silencio mientras el estado decía "abierto", y el
   * botón quedaba muerto hasta salir del módulo y volver a entrar.
   */
  describe('el diálogo no depende del estado del resto de la pantalla', () => {
    it('sobrevive a una recarga del catálogo (loading)', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<EnRouter />);
      await user.click(screen.getByRole('button', { name: /Sembrar desde las compras/i }));

      mockStores({ loading: true });
      rerender(<EnRouter />);

      expect(screen.getByTestId('seed-dialog')).toBeInTheDocument();
    });

    it('sobrevive a un error de carga del catálogo', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<EnRouter />);
      await user.click(screen.getByRole('button', { name: /Sembrar desde las compras/i }));

      mockStores({ error: 'No se pudo cargar el catálogo.' });
      rerender(<EnRouter />);

      expect(screen.getByTestId('seed-dialog')).toBeInTheDocument();
    });

    it('sobrevive a que se vacíe el catálogo de receptores del otro store', async () => {
      // `receptor` sale de dte-parties-store, que se vacía en cualquier reset
      // de sesión. El diálogo solo necesita el `receptorId`.
      const user = userEvent.setup();
      const { rerender } = render(<EnRouter />);
      await user.click(screen.getByRole('button', { name: /Sembrar desde las compras/i }));

      vi.mocked(useDtePartiesStore).mockImplementation(((selector: unknown) =>
        (selector as (s: unknown) => unknown)({
          byRole: { RECEPTOR: { parties: [], loading: false, loaded: true } },
          fetchParties: vi.fn(),
        })) as unknown as typeof useDtePartiesStore);
      rerender(<EnRouter />);

      expect(screen.getByTestId('seed-dialog')).toBeInTheDocument();
    });
  });

  it('sin contribuyente elegido no se puede abrir la siembra', () => {
    mockStores({ receptorId: null });
    render(<EnRouter />);

    expect(
      screen.queryByRole('button', { name: /Sembrar desde las compras/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('seed-dialog')).not.toBeInTheDocument();
  });
});
