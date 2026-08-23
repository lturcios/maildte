import { Role } from '@prisma/client';

/**
 * Se resuelve SOLO en la capa de auth (AuthGuard) y viaja explícito de ahí en más.
 * Prohibido leerlo de variables globales o de un DTO de negocio (skill tenancy).
 * tenantId/tenantSlug son null únicamente para SUPERADMIN (sin tenant, exclusivo de /admin/*).
 * tenantSlug viaja junto al id porque StorageService lo necesita en cada operación de
 * archivo (raíz de storage por tenant, skill tenancy regla 11-13) sin tener que resolverlo
 * de nuevo contra la BD en cada llamada.
 */
export interface TenantContext {
  tenantId: string | null;
  tenantSlug: string | null;
  actor: {
    type: 'user' | 'apikey';
    id: string;
    role: Role;
  };
}
