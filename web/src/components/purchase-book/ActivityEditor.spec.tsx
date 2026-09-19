import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { apiGet, apiPatch } from '@/lib/api-client';
import type { PurchaseDocumentDetail, ResolvedActivity } from '@/types/domain';
import { ActivityEditor } from './ActivityEditor';

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return { ...actual, apiGet: vi.fn(), apiPatch: vi.fn() };
});

const apiGetMock = vi.mocked(apiGet);
const apiPatchMock = vi.mocked(apiPatch);

const RECEPTOR_ID = '22222222-2222-2222-2222-222222222222';
const DOC_ID = '33333333-3333-3333-3333-333333333333';
const RESTAURANTE = '44444444-4444-4444-4444-444444444444';
const CATERING = '55555555-5555-5555-5555-555555555555';

function buildDocument(
  overrides: { activityId?: string | null; resolvedActivity?: ResolvedActivity | null } = {},
): PurchaseDocumentDetail {
  return {
    id: DOC_ID,
    activityId: null,
    activityAssignedById: null,
    activityAssignedAt: null,
    resolvedActivity: { activityId: null, source: 'missing', activity: null },
    receptor: { id: RECEPTOR_ID, nombre: 'Wendy Cocar' },
    ...overrides,
  } as unknown as PurchaseDocumentDetail;
}

function catalogo() {
  return {
    data: [
      { id: RESTAURANTE, nombre: 'Restaurantes', active: true },
      { id: CATERING, nombre: 'Catering', active: true },
      { id: 'retirada', nombre: 'Vieja', active: false },
    ],
  };
}

describe('ActivityEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiGetMock.mockResolvedValue(catalogo());
    apiPatchMock.mockResolvedValue({ data: buildDocument() });
  });

  it('pide el catálogo DEL RECEPTOR de esa compra', async () => {
    render(<ActivityEditor document={buildDocument()} canEdit onSaved={vi.fn()} />);

    await waitFor(() => expect(apiGetMock).toHaveBeenCalledTimes(1));
    expect(apiGetMock).toHaveBeenCalledWith(`/purchase-book/activities?receptorId=${RECEPTOR_ID}`);
  });

  it('no ofrece las actividades retiradas', async () => {
    const user = userEvent.setup();
    render(<ActivityEditor document={buildDocument()} canEdit onSaved={vi.fn()} />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());

    await user.click(screen.getByRole('combobox'));

    expect(await screen.findByRole('option', { name: 'Restaurantes' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Vieja' })).not.toBeInTheDocument();
  });

  it('asignar una actividad manda el PATCH con su id', async () => {
    const user = userEvent.setup();
    render(<ActivityEditor document={buildDocument()} canEdit onSaved={vi.fn()} />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());

    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Catering' }));

    await waitFor(() => expect(apiPatchMock).toHaveBeenCalledTimes(1));
    expect(apiPatchMock).toHaveBeenCalledWith(`/purchase-book/documents/${DOC_ID}/activity`, {
      activityId: CATERING,
    });
  });

  it('"Heredar del proveedor" manda null, que es lo que quita el override', async () => {
    const user = userEvent.setup();
    const document = buildDocument({
      activityId: CATERING,
      resolvedActivity: {
        activityId: CATERING,
        source: 'override',
        activity: { id: CATERING, nombre: 'Catering', codActividad: null, active: true },
      },
    });
    render(<ActivityEditor document={document} canEdit onSaved={vi.fn()} />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: /Quitar la actividad propia/i }));

    await waitFor(() => expect(apiPatchMock).toHaveBeenCalledTimes(1));
    expect(apiPatchMock).toHaveBeenCalledWith(`/purchase-book/documents/${DOC_ID}/activity`, {
      activityId: null,
    });
  });

  it('cuando la hereda del proveedor lo dice, y sugiere corregir el mapeo', async () => {
    const document = buildDocument({
      resolvedActivity: {
        activityId: RESTAURANTE,
        source: 'supplier-default',
        activity: { id: RESTAURANTE, nombre: 'Restaurantes', codActividad: '56101', active: true },
      },
    });
    render(<ActivityEditor document={document} canEdit onSaved={vi.fn()} />);

    expect(await screen.findByText(/conviene cambiar el mapeo del proveedor/i)).toBeInTheDocument();
  });

  it('un MIEMBRO ve la actividad pero no el select ni pide el catálogo', () => {
    const document = buildDocument({
      resolvedActivity: {
        activityId: RESTAURANTE,
        source: 'supplier-default',
        activity: { id: RESTAURANTE, nombre: 'Restaurantes', codActividad: '56101', active: true },
      },
    });
    render(<ActivityEditor document={document} canEdit={false} onSaved={vi.fn()} />);

    expect(screen.getByText(/Restaurantes/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    // El endpoint del catálogo es ADMIN: pedirlo daría 403 y ensuciaría el log.
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it('sin catálogo cargado avisa dónde crearlo', async () => {
    apiGetMock.mockResolvedValue({ data: [] });
    render(<ActivityEditor document={buildDocument()} canEdit onSaved={vi.fn()} />);

    expect(
      await screen.findByText(/todavía no tiene actividades en su catálogo/i),
    ).toBeInTheDocument();
  });
});
