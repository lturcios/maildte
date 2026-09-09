import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import {
  BookOpenText,
  Building2,
  FileStack,
  LayoutDashboard,
  MailSearch,
  MenuIcon,
  Moon,
  ScrollText,
  ServerCog,
  Sun,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { apiPost } from '@/lib/api-client';
import { useAuthStore } from '@/stores/auth-store';
import { endSession } from '@/stores/session';
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
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end: boolean;
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/cuentas', label: 'Cuentas', icon: FileStack, end: false },
  { to: '/correos', label: 'Correos', icon: MailSearch, end: false },
  { to: '/libro-compras', label: 'Libro de compras', icon: BookOpenText, end: false },
  { to: '/logs', label: 'Logs', icon: ScrollText, end: false },
];

/** Solo visibles para SUPERADMIN; las rutas también están protegidas por SuperadminRoute. */
const SUPERADMIN_NAV_ITEMS: readonly NavItem[] = [
  { to: '/organizaciones', label: 'Organizaciones', icon: Building2, end: false },
  { to: '/servicios-correo', label: 'Servicios de correo', icon: ServerCog, end: false },
];

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

interface AppNavProps {
  items: readonly NavItem[];
  onNavigate?: () => void;
}

/** Misma lista de enlaces para el sidebar fijo (md+) y el drawer mobile. */
function AppNav({ items, onNavigate }: AppNavProps) {
  return (
    <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
      {items.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              // min-h-11: objetivo táctil cómodo en mobile, sin agrandar el sidebar de escritorio.
              'flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
            )
          }
        >
          <Icon className="size-4 shrink-0" aria-hidden="true" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

function BrandMark() {
  return (
    <>
      <span className="font-display text-lg font-semibold tracking-tight text-primary">
        MailDTE
      </span>
      <span className="text-xs text-muted-foreground">Collector</span>
    </>
  );
}

export function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuthStore((state) => state.user);
  const theme = useUiStore((state) => state.theme);
  const toggleTheme = useUiStore((state) => state.toggleTheme);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const navItems = user?.role === 'SUPERADMIN' ? SUPERADMIN_NAV_ITEMS : NAV_ITEMS;

  // Un cambio de ruta que no venga de tocar un enlace (back del navegador, un
  // redirect de guard) también debe cerrar el drawer: si no, queda tapando la
  // página nueva. Se ajusta durante el render (mismo patrón "adjusting state
  // when a prop changes" que usan CorreosPage y LogsPage con sus filtros), no en
  // un efecto: un setState en efecto encadena un render extra tras el commit.
  const [lastPathname, setLastPathname] = useState(location.pathname);
  if (location.pathname !== lastPathname) {
    setLastPathname(location.pathname);
    setMobileNavOpen(false);
  }

  async function handleLogout() {
    setIsLoggingOut(true);
    try {
      await apiPost<void>('/auth/logout');
    } catch {
      // El logout local debe completarse igual aunque falle la llamada HTTP.
    } finally {
      // Cierra credenciales y vacía los stores del tenant: sin lo segundo, un
      // login posterior en la misma pestaña reusa el caché de esta sesión.
      endSession();
      setIsLoggingOut(false);
      navigate('/login', { replace: true });
    }
  }

  return (
    <div className="flex min-h-svh bg-background text-foreground">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
        <div className="flex h-16 items-center gap-2 border-b border-sidebar-border px-6">
          <BrandMark />
        </div>
        <AppNav items={navItems} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-border bg-card px-3 sm:px-4 md:px-6">
          <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <SheetTrigger asChild>
              <Button type="button" variant="ghost" size="icon" className="md:hidden">
                <MenuIcon className="size-5" aria-hidden="true" />
                <span className="sr-only">Abrir menú de navegación</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="left">
              <div className="flex h-16 items-center gap-2 border-b border-sidebar-border px-6">
                <SheetTitle asChild>
                  <span className="flex items-baseline gap-2">
                    <BrandMark />
                  </span>
                </SheetTitle>
              </div>
              <AppNav items={navItems} onNavigate={() => setMobileNavOpen(false)} />
            </SheetContent>
          </Sheet>

          <span className="font-display text-base font-semibold md:hidden">MailDTE</span>

          <div className="ml-auto flex items-center gap-1 sm:gap-3">
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
                  <span className="hidden max-w-40 truncate text-sm font-medium sm:inline">
                    {user?.name ?? user?.email ?? 'Usuario'}
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel className="font-normal">
                  <div className="flex max-w-56 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium">{user?.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{user?.email}</span>
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

        <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
