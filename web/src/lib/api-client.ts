import { useAuthStore } from '@/stores/auth-store';
import { endSession } from '@/stores/session';
import type { AuthTokens } from '@/types/auth';

/**
 * Cliente HTTP centralizado para la API de MailDTE Collector.
 *
 * - Prefija `/api/v1` sobre la base configurada (en dev, el proxy de Vite
 *   reenvía `/api` hacia el backend en `http://localhost:3000`; en prod,
 *   Nginx expone la API bajo el mismo origen que sirve el panel).
 * - Agrega `Authorization: Bearer <accessToken>` en cada request autenticado.
 * - En 401, intenta refrescar el token UNA sola vez y reintenta el request
 *   original. Si el refresh falla, limpia el auth store y redirige a /login.
 */

const API_PREFIX = '/api/v1';

/** Forma exacta del error de la API (ver http-exception.filter.ts del backend). */
interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string;
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly error: string;

  constructor(body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.statusCode = body.statusCode;
    this.error = body.error;
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.statusCode === 'number' &&
    typeof candidate.error === 'string' &&
    typeof candidate.message === 'string'
  );
}

async function parseErrorBody(response: Response): Promise<ApiErrorBody> {
  try {
    const json: unknown = await response.json();
    if (isApiErrorBody(json)) {
      return json;
    }
  } catch {
    // El body no era JSON parseable; caemos al error genérico de abajo.
  }
  return {
    statusCode: response.status,
    error: 'UNKNOWN_ERROR',
    message: 'Ocurrió un error inesperado al comunicarse con el servidor.',
  };
}

function redirectToLogin(): void {
  const base = import.meta.env.BASE_URL;
  window.location.href = `${base}login`;
}

let refreshPromise: Promise<string> | null = null;

/** Ejecuta POST /auth/refresh sin pasar por request() para no reentrar en el interceptor. */
async function refreshAccessToken(): Promise<string> {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const currentRefreshToken = useAuthStore.getState().refreshToken;
    if (!currentRefreshToken) {
      throw new Error('No hay refresh token disponible.');
    }

    const response = await fetch(`${API_PREFIX}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: currentRefreshToken }),
    });

    if (!response.ok) {
      const body = await parseErrorBody(response);
      throw new ApiError(body);
    }

    const json = (await response.json()) as { data: AuthTokens };
    useAuthStore.getState().setTokens(json.data);
    return json.data.accessToken;
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  /** Evita el interceptor de 401 (usado por /auth/login y /auth/refresh). */
  skipAuthRetry?: boolean;
  /** true si ya es un reintento post-refresh: evita loops infinitos. */
  isRetry?: boolean;
}

/**
 * Hace el fetch autenticado con el manejo de 401 (refresh-and-retry una sola
 * vez) y de errores no-2xx, y devuelve el `Response` crudo sin parsear el
 * body. `request()` (JSON) y `apiDownload()` (blob) comparten esta función
 * en vez de duplicar la lógica de refresh.
 */
async function fetchWithAuth(options: RequestOptions): Promise<Response> {
  const { method, path, body, skipAuthRetry = false, isRetry = false } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const accessToken = useAuthStore.getState().accessToken;
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const response = await fetch(`${API_PREFIX}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (response.status === 401 && !skipAuthRetry && !isRetry) {
    try {
      await refreshAccessToken();
    } catch {
      // `redirectToLogin()` hace una navegación dura y con eso se pierde todo
      // el estado en memoria, pero el cierre no puede depender de ese efecto
      // lateral: se vacían los stores del tenant explícitamente.
      endSession();
      redirectToLogin();
      throw new ApiError({
        statusCode: 401,
        error: 'SESSION_EXPIRED',
        message: 'Tu sesión expiró. Iniciá sesión nuevamente.',
      });
    }
    return fetchWithAuth({ ...options, isRetry: true });
  }

  if (!response.ok) {
    const errorBody = await parseErrorBody(response);
    throw new ApiError(errorBody);
  }

  return response;
}

async function request<T>(options: RequestOptions): Promise<T> {
  const response = await fetchWithAuth(options);

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>({ method: 'GET', path });
}

export function apiPost<T>(path: string, body?: unknown, skipAuthRetry = false): Promise<T> {
  return request<T>({ method: 'POST', path, body, skipAuthRetry });
}

export function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>({ method: 'PATCH', path, body });
}

export function apiDelete(path: string): Promise<void> {
  return request<void>({ method: 'DELETE', path });
}

export interface DownloadResult {
  blob: Blob;
  /** Nombre de archivo decodificado del header `Content-Disposition`, si vino. */
  filename: string | null;
}

/** Extrae el filename de un header `Content-Disposition: attachment; filename*=UTF-8''<encoded>`. */
function parseFilenameFromContentDisposition(header: string | null): string | null {
  if (!header) {
    return null;
  }
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const plainMatch = /filename="?([^";]+)"?/i.exec(header);
  return plainMatch?.[1] ?? null;
}

/**
 * Descarga un recurso binario (adjuntos) reusando el mismo manejo de
 * autenticación y refresh-on-401 que `request()`, sin intentar parsear la
 * respuesta como JSON.
 */
export async function apiDownload(path: string): Promise<DownloadResult> {
  const response = await fetchWithAuth({ method: 'GET', path });
  const blob = await response.blob();
  const filename = parseFilenameFromContentDisposition(response.headers.get('Content-Disposition'));
  return { blob, filename };
}
