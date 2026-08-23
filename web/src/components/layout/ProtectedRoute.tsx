import { Navigate, Outlet } from 'react-router';

import { useAuthStore } from '@/stores/auth-store';

/**
 * Envuelve las rutas autenticadas. Si no hay accessToken en el store,
 * redirige a /login. La validez real del token la resuelve el backend
 * (y el interceptor 401 del api-client) en cada request.
 */
export function ProtectedRoute() {
  const accessToken = useAuthStore((state) => state.accessToken);

  if (!accessToken) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
