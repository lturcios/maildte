import { Navigate, Outlet } from 'react-router';

import { useAuthStore } from '@/stores/auth-store';

/**
 * Envuelve las rutas exclusivas de SUPERADMIN (gestión de tenants). Se monta
 * dentro de <ProtectedRoute>/<AppLayout>, así que ya hay una sesión válida:
 * acá solo falta el chequeo de rol. Es puramente UX — la barrera de
 * seguridad real es el guard @Roles(Role.SUPERADMIN) del AdminController en
 * el backend, que responde 403 ante cualquier request de un rol distinto.
 */
export function SuperadminRoute() {
  const role = useAuthStore((state) => state.user?.role);

  if (role !== 'SUPERADMIN') {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
