import { Readable } from 'node:stream';
import { ManifestEntry, ManifestPage, RemoteAccount } from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private headers(): Record<string, string> {
    return { 'X-Api-Key': this.apiKey };
  }

  private url(path: string, query: Record<string, string | number | undefined> = {}): string {
    const base = this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`;
    const url = new URL(path.replace(/^\//, ''), base);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async listAccounts(): Promise<RemoteAccount[]> {
    const res = await fetch(this.url('accounts'), { headers: this.headers() });
    if (!res.ok) {
      throw new ApiError(`No se pudieron listar las cuentas (HTTP ${res.status})`, res.status);
    }
    const body = (await res.json()) as { data: RemoteAccount[] };
    return body.data;
  }

  async fetchManifestPage(params: {
    accountId: string;
    since?: string;
    month?: string;
    cursorId?: string;
    limit?: number;
  }): Promise<ManifestPage> {
    const res = await fetch(
      this.url('export/manifest', {
        accountId: params.accountId,
        since: params.since,
        month: params.month,
        cursorId: params.cursorId,
        limit: params.limit ?? 500,
      }),
      { headers: this.headers() },
    );
    if (!res.ok) {
      const body = await res.text();
      throw new ApiError(`Error al pedir el manifiesto (HTTP ${res.status}): ${body}`, res.status);
    }
    return (await res.json()) as ManifestPage;
  }

  async *fetchFullManifest(params: {
    accountId: string;
    since?: string;
    month?: string;
  }): AsyncGenerator<{ page: ManifestPage; entries: ManifestEntry[] }> {
    let cursorId: string | undefined;
    do {
      const page = await this.fetchManifestPage({ ...params, cursorId });
      yield { page, entries: page.data };
      cursorId = page.meta.nextCursor ?? undefined;
    } while (cursorId);
  }

  async downloadAttachment(attachmentId: string): Promise<Readable> {
    const res = await fetch(this.url(`attachments/${attachmentId}/download`), {
      headers: this.headers(),
    });
    if (!res.ok || !res.body) {
      throw new ApiError(
        `No se pudo descargar el adjunto ${attachmentId} (HTTP ${res.status})`,
        res.status,
      );
    }
    return Readable.fromWeb(res.body);
  }

  async downloadArchive(params: {
    accountId: string;
    since?: string;
    month?: string;
  }): Promise<Readable> {
    const res = await fetch(
      this.url('export/archive', {
        accountId: params.accountId,
        since: params.since,
        month: params.month,
      }),
      { headers: this.headers() },
    );
    if (!res.ok || !res.body) {
      const body = res.body ? '' : await res.text().catch(() => '');
      throw new ApiError(`No se pudo descargar el ZIP (HTTP ${res.status}): ${body}`, res.status);
    }
    return Readable.fromWeb(res.body);
  }
}
