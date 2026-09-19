import { render, screen } from '@testing-library/react';

import type { ResolvedActivity } from '@/types/domain';
import { ActivityBadge } from '@/components/purchase-book/ActivityBadge';
import {
  buildFiltersQuery,
  countActiveFilters,
  DEFAULT_FILTERS,
} from '@/lib/purchase-book-filters';
import type { Filters } from '@/lib/purchase-book-filters';

const ACTIVITY_ID = '44444444-4444-4444-4444-444444444444';
const RECEPTOR_ID = '22222222-2222-2222-2222-222222222222';

function filtros(overrides: Partial<Filters> = {}): Filters {
  return { ...DEFAULT_FILTERS, ...overrides };
}

describe('buildFiltersQuery — actividad', () => {
  it('sin filtro de actividad no manda el parámetro', () => {
    expect(buildFiltersQuery(filtros(), '')).not.toContain('activityId');
  });

  it('manda el id de la actividad elegida', () => {
    const query = buildFiltersQuery(filtros({ activityId: ACTIVITY_ID }), '');
    expect(new URLSearchParams(query).get('activityId')).toBe(ACTIVITY_ID);
  });

  it('manda el literal none para las compras sin actividad', () => {
    const query = buildFiltersQuery(filtros({ activityId: 'none' }), '');
    expect(new URLSearchParams(query).get('activityId')).toBe('none');
  });

  it('el filtro de actividad convive con el resto', () => {
    const query = buildFiltersQuery(
      filtros({ receptorId: RECEPTOR_ID, month: '2026-05', activityId: ACTIVITY_ID }),
      'ferreteria',
    );
    const params = new URLSearchParams(query);

    expect(params.get('receptorId')).toBe(RECEPTOR_ID);
    expect(params.get('month')).toBe('2026-05');
    expect(params.get('activityId')).toBe(ACTIVITY_ID);
    expect(params.get('q')).toBe('ferreteria');
  });
});

describe('countActiveFilters', () => {
  it('cuenta la actividad como filtro activo', () => {
    // El contador del panel le avisa al usuario que está viendo un subconjunto.
    // Si la actividad no contara, un libro filtrado se vería como completo.
    expect(countActiveFilters(filtros(), '')).toBe(0);
    expect(countActiveFilters(filtros({ activityId: ACTIVITY_ID }), '')).toBe(1);
    expect(countActiveFilters(filtros({ activityId: 'none' }), '')).toBe(1);
  });
});

describe('ActivityBadge', () => {
  function badge(resolved: ResolvedActivity | null) {
    return render(<ActivityBadge resolved={resolved} />);
  }

  it('sin actividad resuelta lo dice', () => {
    badge({ activityId: null, source: 'missing', activity: null });
    expect(screen.getByText('Sin actividad')).toBeInTheDocument();
  });

  it('un documento sin el campo tampoco rompe', () => {
    badge(null);
    expect(screen.getByText('Sin actividad')).toBeInTheDocument();
  });

  /**
   * El origen es lo que decide DÓNDE corregir: una heredada se arregla para
   * todas las compras de ese proveedor mapeándolo una vez; un override es de
   * esa compra sola. Con el nombre solo, las dos se ven igual.
   */
  it('distingue la heredada del proveedor de la propia de la compra', () => {
    const activity = {
      id: ACTIVITY_ID,
      nombre: 'Restaurantes',
      codActividad: '56101',
      active: true,
    };

    const { unmount } = badge({ activityId: ACTIVITY_ID, source: 'supplier-default', activity });
    expect(screen.getByText('Del proveedor')).toBeInTheDocument();
    unmount();

    badge({ activityId: ACTIVITY_ID, source: 'override', activity });
    expect(screen.getByText('Propia de esta compra')).toBeInTheDocument();
  });

  it('una actividad que ya no está en el catálogo no rompe la fila', () => {
    badge({ activityId: ACTIVITY_ID, source: 'override', activity: null });
    expect(screen.getByText('Actividad no encontrada')).toBeInTheDocument();
  });
});
