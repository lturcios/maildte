import { useState } from 'react';
import { ChevronDownIcon, SlidersHorizontalIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useIsDesktop } from '@/hooks/useMediaQuery';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

interface FiltersPanelProps {
  /** Cuántos filtros están aplicados; se muestra como badge cuando el panel está plegado. */
  activeCount: number;
  onClear?: () => void;
  /** Columnas de la grilla a partir de `sm`. Mobile siempre es una sola columna. */
  gridClassName?: string;
  children: React.ReactNode;
}

/**
 * Contenedor de filtros con comportamiento distinto por viewport.
 *
 * En mobile los filtros arrancan PLEGADOS: seis campos apilados empujan la tabla
 * fuera de la pantalla y el usuario aterriza sin ver un solo dato. El disparador
 * muestra cuántos filtros hay activos, para que plegado no signifique invisible.
 * En `md+` hay espacio de sobra y el panel está siempre abierto.
 *
 * El estado abierto de escritorio se fuerza con una media query en JS y no con
 * una clase `md:block!` sobre el contenido montado a la fuerza: el preflight de
 * Tailwind v4 declara `[hidden] { display: none !important }` en `@layer base`,
 * y entre declaraciones `!important` el orden de capas se invierte — `base` le
 * gana a `utilities`. La clase perdería y los filtros quedarían invisibles en
 * escritorio.
 */
export function FiltersPanel({
  activeCount,
  onClear,
  gridClassName = 'sm:grid-cols-2 lg:grid-cols-3',
  children,
}: FiltersPanelProps) {
  const isDesktop = useIsDesktop();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <Collapsible
      open={isDesktop || mobileOpen}
      onOpenChange={setMobileOpen}
      className="rounded-lg border border-border bg-card"
    >
      <div className="flex items-center justify-between gap-2 md:hidden">
        <CollapsibleTrigger className="flex min-h-12 flex-1 items-center gap-2 px-4 text-sm font-medium">
          <SlidersHorizontalIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          Filtros
          {activeCount > 0 && (
            <Badge variant="secondary" className="ml-1">
              {activeCount}
            </Badge>
          )}
          <ChevronDownIcon
            className={cn(
              'ml-auto size-4 text-muted-foreground transition-transform',
              mobileOpen && 'rotate-180',
            )}
            aria-hidden="true"
          />
        </CollapsibleTrigger>
        {activeCount > 0 && onClear && (
          <button
            type="button"
            onClick={onClear}
            className="min-h-12 shrink-0 px-4 text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            Limpiar
          </button>
        )}
      </div>

      <CollapsibleContent>
        <div className={cn('grid gap-4 border-t border-border p-4 md:border-t-0', gridClassName)}>
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
