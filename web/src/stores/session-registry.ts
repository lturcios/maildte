/**
 * Registro de stores que deben vaciarse al cambiar de sesión.
 *
 * Es un módulo hoja a propósito: no importa ningún store ni el cliente HTTP.
 * Si `session.ts` importara los stores de datos y `api-client.ts` importara
 * `session.ts`, se cerraría un ciclo (api-client -> session -> store ->
 * api-client) que ya rompió el mock del cliente en los tests y deja a los
 * módulos viéndose entre sí a medio evaluar.
 *
 * Cada store se registra al ser importado, así que agregar un store nuevo no
 * exige acordarse de sumarlo a una lista: si tiene datos en memoria, es porque
 * alguien lo importó, y entonces ya está registrado.
 */

type ResetFn = () => void;

const resettableStores = new Set<ResetFn>();

/** Se llama una vez por store, junto a su definición. */
export function registerSessionStore(reset: ResetFn): void {
  resettableStores.add(reset);
}

/**
 * Devuelve todos los stores de sesión a su estado inicial, con `loaded` en
 * false para que el próximo consumidor vuelva a pedir los datos al servidor.
 */
export function resetTenantStores(): void {
  for (const reset of resettableStores) {
    reset();
  }
}
