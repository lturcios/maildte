import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { apiDownload } from '@/lib/api-client';
import type { PurchaseBookSummary } from '@/types/domain';
import { ExportAnexoPanel } from './ExportAnexoPanel';

// Solo se sustituye la descarga: `ApiError` y el resto del cliente quedan
// reales, porque el componente hace `error instanceof ApiError`.
vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return { ...actual, apiDownload: vi.fn() };
});

const apiDownloadMock = vi.mocked(apiDownload);

const RECEPTOR_ID = '22222222-2222-2222-2222-222222222222';
const FILTERS_QUERY = `receptorId=${RECEPTOR_ID}&fecEmiFrom=2026-05-01&fecEmiTo=2026-05-31`;

const MSG_RECEPTOR = /El Anexo 3 se presenta por contribuyente/i;
const MSG_FILTRO_VACIO = /El filtro actual no incluye compras para exportar/i;

function buildSummary(overrides: Partial<PurchaseBookSummary> = {}): PurchaseBookSummary {
  return {
    documentCount: 12,
    totalExenta: '0.00',
    totalNoSuj: '0.00',
    totalGravada: '1728.00',
    ivaCreditoFiscal: '224.64',
    montoTotalOperacion: '1952.64',
    unclassifiedCount: 0,
    jsonAttachmentsWithoutParse: 0,
    ...overrides,
  };
}

function renderPanel(
  options: {
    summary?: PurchaseBookSummary | null;
    receptorSelected?: boolean;
    filtersQuery?: string;
  } = {},
) {
  const {
    summary = buildSummary(),
    receptorSelected = true,
    filtersQuery = FILTERS_QUERY,
  } = options;

  return render(
    <ExportAnexoPanel
      filtersQuery={filtersQuery}
      summary={summary}
      receptorSelected={receptorSelected}
    />,
  );
}

function csvButton(): HTMLElement {
  return screen.getByRole('button', { name: /CSV/i });
}

function xlsxButton(): HTMLElement {
  return screen.getByRole('button', { name: /Excel/i });
}

describe('ExportAnexoPanel', () => {
  beforeEach(() => {
    apiDownloadMock.mockReset();
    apiDownloadMock.mockResolvedValue({
      blob: new Blob(['contenido'], { type: 'text/csv' }),
      filename: 'anexo3.csv',
    });
  });

  it('bloquea el export cuando no hay un receptor seleccionado, aunque el filtro traiga compras', () => {
    renderPanel({ receptorSelected: false, summary: buildSummary({ documentCount: 12 }) });

    expect(csvButton()).toBeDisabled();
    expect(xlsxButton()).toBeDisabled();
    expect(screen.getByText(MSG_RECEPTOR)).toBeInTheDocument();
  });

  it('habilita ambos formatos y anuncia el conteo cuando hay receptor y compras', () => {
    renderPanel({ summary: buildSummary({ documentCount: 12 }) });

    expect(csvButton()).toBeEnabled();
    expect(xlsxButton()).toBeEnabled();
    expect(screen.getByText(/Se exportarán 12 compras del filtro activo/i)).toBeInTheDocument();
    expect(screen.queryByText(MSG_RECEPTOR)).not.toBeInTheDocument();
  });

  it('con receptor pero sin compras muestra el mensaje de filtro vacío, no el de receptor', () => {
    renderPanel({ summary: buildSummary({ documentCount: 0 }) });

    expect(csvButton()).toBeDisabled();
    expect(xlsxButton()).toBeDisabled();
    expect(screen.getByText(MSG_FILTRO_VACIO)).toBeInTheDocument();
    expect(screen.queryByText(MSG_RECEPTOR)).not.toBeInTheDocument();
  });

  it('ofrece el checkbox de compras sin clasificar solo cuando hay alguna', () => {
    const { unmount } = renderPanel({ summary: buildSummary({ unclassifiedCount: 0 }) });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    unmount();

    renderPanel({ summary: buildSummary({ unclassifiedCount: 3 }) });
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
  });

  it('manda allowUnclassified en la query solo si el checkbox está marcado', async () => {
    const user = userEvent.setup();
    renderPanel({ summary: buildSummary({ documentCount: 12, unclassifiedCount: 3 }) });

    await user.click(csvButton());
    await waitFor(() => {
      expect(apiDownloadMock).toHaveBeenCalledTimes(1);
    });
    expect(apiDownloadMock).toHaveBeenLastCalledWith(
      `/purchase-book/export?${FILTERS_QUERY}&format=csv`,
    );

    await user.click(screen.getByRole('checkbox'));
    await user.click(xlsxButton());
    await waitFor(() => {
      expect(apiDownloadMock).toHaveBeenCalledTimes(2);
    });
    expect(apiDownloadMock).toHaveBeenLastCalledWith(
      `/purchase-book/export?${FILTERS_QUERY}&format=xlsx&allowUnclassified=true`,
    );
  });
});
