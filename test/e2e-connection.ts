/**
 * Coordenadas de Postgres y Redis para la suite e2e.
 *
 * Los valores por defecto son los de `docker-compose.yml` (5433 y 6379): quien
 * no exporte nada sigue corriendo `pnpm test:e2e` exactamente como antes. Las
 * variables existen porque esos dos puertos son de uso común en la máquina de
 * un desarrollador y otro proyecto levantado en paralelo puede tenerlos
 * tomados; en ese caso se levanta MailDTE en otros puertos (ver
 * `docker-compose.e2e-ports.yml`) y se apuntan estas variables ahí, sin tocar
 * ni el compose base ni este archivo.
 *
 * Solo se parametrizan host y puerto: usuario, contraseña y nombres de base
 * son los que crean el compose y la migración `multi_tenancy`, y cambiarlos
 * no resuelve ningún conflicto de puertos.
 */

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

const POSTGRES_HOST = env('E2E_POSTGRES_HOST', 'localhost');
const POSTGRES_PORT = env('E2E_POSTGRES_PORT', '5433');
const REDIS_HOST = env('E2E_REDIS_HOST', 'localhost');
const REDIS_PORT = env('E2E_REDIS_PORT', '6379');

/** Base administrativa: existe desde el arranque del contenedor y es donde se ejecuta el `CREATE DATABASE`. */
export const ADMIN_DB_NAME = 'maildte';
/** Base que la suite crea y migra. Se recrea sola si no existe. */
export const TEST_DB_NAME = 'maildte_test';

/** Rol dueño del esquema: crea la base y aplica las migraciones. */
export const ADMIN_URL = `postgresql://maildte:secret@${POSTGRES_HOST}:${POSTGRES_PORT}/${ADMIN_DB_NAME}`;
export const TEST_URL = `postgresql://maildte:secret@${POSTGRES_HOST}:${POSTGRES_PORT}/${TEST_DB_NAME}`;

/**
 * Rol restringido (no superusuario): sin esto, RLS queda bypaseado y los tests
 * de aislamiento no prueban nada real (ver comentario en la migración
 * multi_tenancy).
 */
export const APP_TEST_URL = `postgresql://maildte_app:maildte_app_dev_only@${POSTGRES_HOST}:${POSTGRES_PORT}/${TEST_DB_NAME}`;

/** DB 1: aislada de los datos de desarrollo (DB 0). */
export const REDIS_TEST_URL = `redis://${REDIS_HOST}:${REDIS_PORT}/1`;
