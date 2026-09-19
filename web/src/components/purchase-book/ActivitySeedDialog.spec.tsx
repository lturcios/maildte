import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { usePurchaseActivitiesStore } from '@/stores/purchase-activities-store';
import type { ActivitySeedApplyResult, ActivitySeedProposal } from '@/types/domain';
import { ActivitySeedDialog } from './ActivitySeedDialog';

const RECEPTOR_ID = '22222222-2222-2222-2222-222222222222';

const proposeSeed = vi.fn<(receptorId: string) => Promise<ActivitySeedProposal>>();
const applySeed = vi.fn();

vi.mock('@/stores/purchase-activities-store', () => ({
  usePurchaseActivitiesStore: vi.fn(),
}));

/**
 * El store se lee con selectores (`useStore((s) => s.proposeSeed)`), así que el
 * mock tiene que aplicar el selector a un estado falso en vez de devolver un
 * objeto fijo.
 */
function mockStore() {
  vi.mocked(usePurchaseActivitiesStore).mockImplementation(((selector: unknown) =>
    (selector as (state: unknown) => unknown)({
      proposeSeed,
      applySeed,
    })) as unknown as typeof usePurchaseActivitiesStore);
}

/** La propuesta real del contribuyente que motivó la fase 3. */
function proposal(): ActivitySeedProposal {
  return {
    receptorId: RECEPTOR_ID,
    activities: [
      { codActividad: '56101', nombre: 'RESTAURANTES', documentCount: 561 },
      { codActividad: '56107', nombre: 'Actividades varias', documentCount: 290 },
    ],
    mappings: [
      {
        emisorId: 'e-1',
        emisorNit: '0614',
        emisorNombre: 'Distribuidora A',
        codActividad: '56101',
        activityNombre: 'RESTAURANTES',
        documentCount: 400,
        matchingCount: 400,
      },
      {
        emisorId: 'e-2',
        emisorNit: '0615',
        emisorNombre: 'Distribuidora B',
        codActividad: '56107',
        activityNombre: 'Actividades varias',
        documentCount: 290,
        matchingCount: 290,
      },
    ],
    documentsWithoutActivity: 11,
  };
}

function applyResult(): ActivitySeedApplyResult {
  return {
    receptorId: RECEPTOR_ID,
    activitiesCreated: 1,
    activitiesSkipped: 0,
    mappingsCreated: 2,
    mappingsSkipped: 0,
    skippedActivityNames: [],
    skippedEmisorIds: [],
  };
}

function renderDialog() {
  return render(
    <ActivitySeedDialog
      receptorId={RECEPTOR_ID}
      receptorNombre="Wendy Cocar"
      open
      onOpenChange={vi.fn()}
    />,
  );
}

describe('ActivitySeedDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore();
    proposeSeed.mockResolvedValue(proposal());
    applySeed.mockResolvedValue(applyResult());
  });

  it('muestra las actividades propuestas con su volumen de compras', async () => {
    renderDialog();

    await waitFor(() => expect(screen.getByDisplayValue('RESTAURANTES')).toBeInTheDocument());
    expect(screen.getByDisplayValue('Actividades varias')).toBeInTheDocument();
    expect(screen.getByText(/561 compra/)).toBeInTheDocument();
  });

  it('avisa cuántas compras no declaran actividad y quedan fuera', async () => {
    renderDialog();

    await waitFor(() => expect(screen.getByDisplayValue('RESTAURANTES')).toBeInTheDocument());
    expect(screen.getByText(/11 compra\(s\) no declaran actividad/)).toBeInTheDocument();
  });

  it('fusionar dos propuestas manda UNA actividad con los DOS proveedores', async () => {
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => expect(screen.getByDisplayValue('RESTAURANTES')).toBeInTheDocument());

    // "Actividades varias" es lo mismo que "RESTAURANTES": el código lo eligió
    // el proveedor, no el contribuyente.
    await user.click(screen.getByRole('combobox', { name: /Fusionar Actividades varias/i }));
    await user.click(await screen.findByRole('option', { name: 'RESTAURANTES' }));

    await user.click(screen.getByRole('button', { name: 'Aplicar' }));

    await waitFor(() => expect(applySeed).toHaveBeenCalledTimes(1));
    expect(applySeed).toHaveBeenCalledWith({
      receptorId: RECEPTOR_ID,
      confirm: true,
      activities: [{ nombre: 'RESTAURANTES', codActividad: '56101' }],
      mappings: [
        { emisorId: 'e-1', activityNombre: 'RESTAURANTES' },
        { emisorId: 'e-2', activityNombre: 'RESTAURANTES' },
      ],
    });
  });

  it('sin fusionar manda las dos actividades por separado', async () => {
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => expect(screen.getByDisplayValue('RESTAURANTES')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Aplicar' }));

    await waitFor(() => expect(applySeed).toHaveBeenCalledTimes(1));
    const payload = applySeed.mock.calls[0]?.[0] as { activities: unknown[] };
    expect(payload.activities).toHaveLength(2);
  });

  it('descartar una propuesta deja a su proveedor fuera del lote', async () => {
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => expect(screen.getByDisplayValue('RESTAURANTES')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Descartar Actividades varias/i }));
    await user.click(screen.getByRole('button', { name: 'Aplicar' }));

    await waitFor(() => expect(applySeed).toHaveBeenCalledTimes(1));
    expect(applySeed).toHaveBeenCalledWith(
      expect.objectContaining({
        activities: [{ nombre: 'RESTAURANTES', codActividad: '56101' }],
        mappings: [{ emisorId: 'e-1', activityNombre: 'RESTAURANTES' }],
      }),
    );
  });

  it('el nombre editado es el que se siembra, no el que vino del DTE', async () => {
    const user = userEvent.setup();
    renderDialog();
    const input = await screen.findByDisplayValue('RESTAURANTES');

    await user.clear(input);
    await user.type(input, 'Restaurante centro');
    await user.click(screen.getByRole('button', { name: 'Aplicar' }));

    await waitFor(() => expect(applySeed).toHaveBeenCalledTimes(1));
    const payload = applySeed.mock.calls[0]?.[0] as {
      activities: { nombre: string }[];
    };
    expect(payload.activities.map((a) => a.nombre)).toContain('Restaurante centro');
  });

  it('no deja aplicar si se descartó todo: no hay nada que sembrar', async () => {
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => expect(screen.getByDisplayValue('RESTAURANTES')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Descartar RESTAURANTES/i }));
    await user.click(screen.getByRole('button', { name: /Descartar Actividades varias/i }));

    expect(screen.getByRole('button', { name: 'Aplicar' })).toBeDisabled();
    expect(applySeed).not.toHaveBeenCalled();
  });

  it('avisa cuando el contribuyente no tiene ninguna actividad que proponer', async () => {
    proposeSeed.mockResolvedValue({
      receptorId: RECEPTOR_ID,
      activities: [],
      mappings: [],
      documentsWithoutActivity: 0,
    });

    renderDialog();

    expect(
      await screen.findByText(/Ninguna compra de este contribuyente declara una actividad/i),
    ).toBeInTheDocument();
  });

  it('un fallo al pedir la propuesta se muestra y no rompe el diálogo', async () => {
    proposeSeed.mockRejectedValue(new Error('boom'));

    renderDialog();

    const alerta = await screen.findByRole('alert');
    expect(within(alerta).getByText(/No se pudo calcular la propuesta/i)).toBeInTheDocument();
  });
});
