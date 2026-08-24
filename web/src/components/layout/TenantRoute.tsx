import { Navigate, Outlet } from 'react-router';

import { useAuthStore } from '@/stores/auth-store';

/**
 * Envuelve las rutas de negocio (dashboard, cuentas, correos, logs). El
 * SUPERADMIN no tiene tenant y esos endpoints devuelven 403 por diseño (ver
 * StatsService y AccountsService.requireTenantId) — lo mandamos directo a
 * /organizaciones en vez de dejarlo en una pantalla que siempre rompe.
 */
export function TenantRoute() {
  const role = useAuthStore((state) => state.user?.role);

  if (role === 'SUPERADMIN') {
    return <Navigate to="/organizaciones" replace />;
  }

  return <Outlet />;
}
