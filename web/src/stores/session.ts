import { useAuthStore } from './auth-store';
import { resetTenantStores } from './session-registry';
import type { AuthTokens } from '@/types/auth';

/**
 * Ciclo de vida de la sesión del panel.
 *
 * Los stores de datos viven en memoria (sin `persist`) y cachean con un flag
 * `loaded` que evita volver a pedir al servidor. Dentro de la misma pestaña, un
 * logout seguido de un login NO recarga la aplicación: los módulos siguen vivos
 * y, con `loaded === true`, la sesión nueva renderiza los datos de la anterior.
 * Eso ya ocurrió en producción — un operador cerró sesión de un tenant, entró
 * con otro y siguió viendo los receptores, proveedores y cuentas del primero.
 *
 * La regla es una sola y no admite excepciones que haya que recordar: TODO
 * store alimentado por la API autenticada se vacía al abrir y al cerrar sesión
 * (se registran en src/stores/session-registry.ts). Quedan afuera únicamente
 * `auth-store`, que es el dueño de la sesión, y `ui-store`, que guarda
 * preferencias del dispositivo y se persiste a propósito.
 *
 * El reset se dispara desde acá y no desde `auth-store` para que los stores de
 * datos no tengan que conocer la sesión.
 */

export { resetTenantStores } from './session-registry';

/**
 * Abre una sesión: limpia lo que haya quedado de la anterior y recién ahí
 * guarda los tokens nuevos. Se resetea también al entrar, no solo al salir,
 * porque una sesión puede ser reemplazada sin logout explícito (token vencido,
 * otra cuenta que inicia sesión en la misma pestaña).
 */
export function startSession(tokens: AuthTokens): void {
  resetTenantStores();
  useAuthStore.getState().setTokens(tokens);
}

/** Cierra la sesión: borra las credenciales y vacía los datos del tenant. */
export function endSession(): void {
  useAuthStore.getState().logout();
  resetTenantStores();
}
