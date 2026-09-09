import { BrowserRouter, Navigate, Route, Routes } from 'react-router';

import { AppLayout } from '@/components/layout/AppLayout';
import { ProtectedRoute } from '@/components/layout/ProtectedRoute';
import { SuperadminRoute } from '@/components/layout/SuperadminRoute';
import { TenantRoute } from '@/components/layout/TenantRoute';
import { Toaster } from '@/components/ui/sonner';
import { CorreosPage } from '@/pages/CorreosPage';
import { CuentasPage } from '@/pages/CuentasPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { LibroComprasPage } from '@/pages/LibroComprasPage';
import { LoginPage } from '@/pages/LoginPage';
import { LogsPage } from '@/pages/LogsPage';
import { OrganizacionesPage } from '@/pages/OrganizacionesPage';
import { ReceptoresPage } from '@/pages/ReceptoresPage';
import { ServiciosCorreoPage } from '@/pages/ServiciosCorreoPage';

// react-router no matchea rutas si el basename trae "/" final; BASE_URL de
// Vite (config `base: '/panel/'`) sí lo trae.
const routerBasename = import.meta.env.BASE_URL.replace(/\/$/, '');

function App() {
  return (
    <BrowserRouter basename={routerBasename}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />

        <Route element={<ProtectedRoute />}>
          <Route element={<AppLayout />}>
            <Route element={<TenantRoute />}>
              <Route index element={<DashboardPage />} />
              <Route path="cuentas" element={<CuentasPage />} />
              <Route path="correos" element={<CorreosPage />} />
              <Route path="logs" element={<LogsPage />} />
              <Route path="libro-compras" element={<LibroComprasPage />} />
              <Route path="libro-compras/receptores" element={<ReceptoresPage />} />
            </Route>
            <Route element={<SuperadminRoute />}>
              <Route path="organizaciones" element={<OrganizacionesPage />} />
              <Route path="servicios-correo" element={<ServiciosCorreoPage />} />
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      <Toaster />
    </BrowserRouter>
  );
}

export default App;
