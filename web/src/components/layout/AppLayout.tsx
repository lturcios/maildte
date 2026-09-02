import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import {
  Building2,
  FileStack,
  LayoutDashboard,
  MailSearch,
  Moon,
  ScrollText,
  ServerCog,
  Sun,
} from 'lucide-react';

import { apiPost } from '@/lib/api-client';
import { useAuthStore } from '@/stores/auth-store';
import { useUiStore } from '@/stores/ui-store';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/cuentas', label: 'Cuentas', icon: FileStack, end: false },
  { to: '/correos', label: 'Correos', icon: MailSearch, end: false },
  { to: '/logs', label: 'Logs', icon: ScrollText, end: false },
] as const;

/** Solo visibles para SUPERADMIN; las rutas también están protegidas por SuperadminRoute. */
const SUPERADMIN_NAV_ITEMS = [
  { to: '/organizaciones', label: 'Organizaciones', icon: Building2, end: false },
  { to: '/servicios-correo', label: 'Servicios de correo', icon: ServerCog, end: false },
] as const;

function initialsFrom(name: string, email: string): string {
  const source = name.trim() || email;
  const parts = source.split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) {
    return '?';
  }
  if (parts.length === 1) {
    return first.slice(0, 2).toUpperCase();
  }
  const last = parts[parts.length - 1] ?? first;
  return `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase();
}

export function AppLayout() {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const theme = useUiStore((state) => state.theme);
  const toggleTheme = useUiStore((state) => state.toggleTheme);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  async function handleLogout() {
    setIsLoggingOut(true);
    try {
      await apiPost<void>('/auth/logout');
    } catch {
      // El logout local debe completarse igual aunque falle la llamada HTTP.
    } finally {
      logout();
      setIsLoggingOut(false);
      navigate('/login', { replace: true });
    }
  }

  return (
    <div className="flex min-h-svh bg-background text-foreground">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
        <div className="flex h-16 items-center gap-2 border-b border-sidebar-border px-6">
          <span className="font-display text-lg font-semibold tracking-tight text-primary">
            MailDTE
          </span>
          <span className="text-xs text-muted-foreground">Collector</span>
        </div>
        <nav className="flex flex-1 flex-col gap-1 p-3">
          {(user?.role === 'SUPERADMIN' ? SUPERADMIN_NAV_ITEMS : NAV_ITEMS).map(
            ({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                      : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
                  )
                }
              >
                <Icon className="size-4" aria-hidden="true" />
                {label}
              </NavLink>
            ),
          )}
        </nav>
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex h-16 items-center justify-between border-b border-border bg-card px-4 md:px-6">
          <span className="font-display text-base font-semibold md:hidden">MailDTE</span>
          <div className="ml-auto flex items-center gap-3">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={theme === 'dark' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
              onClick={toggleTheme}
            >
              {theme === 'dark' ? (
                <Sun className="size-4" aria-hidden="true" />
              ) : (
                <Moon className="size-4" aria-hidden="true" />
              )}
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" className="gap-2 px-2">
                  <Avatar className="size-8">
                    <AvatarFallback className="bg-primary text-primary-foreground text-xs font-semibold">
                      {initialsFrom(user?.name ?? '', user?.email ?? '')}
                    </AvatarFallback>
                  </Avatar>
                  <span className="hidden text-sm font-medium sm:inline">
                    {user?.name ?? user?.email ?? 'Usuario'}
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel className="font-normal">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{user?.name}</span>
                    <span className="text-xs text-muted-foreground">{user?.email}</span>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  disabled={isLoggingOut}
                  onSelect={(event) => {
                    event.preventDefault();
                    void handleLogout();
                  }}
                >
                  Cerrar sesión
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
