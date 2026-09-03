import * as React from 'react';

import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Primitivas de "una fila = una card" para viewports chicos.
 *
 * En mobile una tabla de 6-9 columnas obliga a scroll horizontal, que esconde
 * datos y rompe la lectura. En vez de encoger la tabla, cada registro se
 * reordena en una card con jerarquía propia: título (el identificador que el
 * usuario busca), metadato secundario, campos etiquetados y acciones al pie con
 * área táctil completa. Las páginas renderizan cards en `<md` y la tabla en
 * `md+`, no la misma grilla a dos tamaños.
 */
function RecordCardList({ className, ...props }: React.ComponentProps<'ul'>) {
  return <ul className={cn('flex flex-col gap-3', className)} {...props} />;
}

function RecordCard({ className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      className={cn(
        'flex flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-sm',
        className,
      )}
      {...props}
    />
  );
}

interface RecordCardHeaderProps {
  title: React.ReactNode;
  /** Línea secundaria bajo el título: correo, remitente, slug, etc. */
  subtitle?: React.ReactNode;
  /** Badge de estado o similar, alineado a la derecha del título. */
  aside?: React.ReactNode;
  onClick?: () => void;
}

function RecordCardHeader({ title, subtitle, aside, onClick }: RecordCardHeaderProps) {
  const content = (
    <>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{title}</span>
        {subtitle !== undefined && (
          <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
        )}
      </div>
      {aside !== undefined && <div className="shrink-0">{aside}</div>}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="-m-1 flex items-start justify-between gap-3 rounded-md p-1 text-left focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {content}
      </button>
    );
  }

  return <div className="flex items-start justify-between gap-3">{content}</div>;
}

interface RecordCardFieldsProps extends React.ComponentProps<'dl'> {
  /** Una columna por defecto; dos cuando los valores son cortos (contadores, fechas). */
  columns?: 1 | 2;
}

function RecordCardFields({ className, columns = 1, ...props }: RecordCardFieldsProps) {
  return (
    <dl
      className={cn(
        'grid gap-x-4 gap-y-2 text-sm',
        columns === 2 ? 'grid-cols-2' : 'grid-cols-1',
        className,
      )}
      {...props}
    />
  );
}

interface RecordCardFieldProps {
  label: string;
  children: React.ReactNode;
}

function RecordCardField({ label, children }: RecordCardFieldProps) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm">{children}</dd>
    </div>
  );
}

/** Pie de acciones: los botones ocupan el ancho completo para dar área táctil real. */
function RecordCardActions({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 border-t border-border pt-3 [&>*]:flex-1',
        className,
      )}
      {...props}
    />
  );
}

function RecordCardSkeletons({ count = 4 }: { count?: number }) {
  return (
    <RecordCardList aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <RecordCard key={index}>
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-full" />
        </RecordCard>
      ))}
    </RecordCardList>
  );
}

function RecordCardEmpty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

export {
  RecordCard,
  RecordCardActions,
  RecordCardEmpty,
  RecordCardField,
  RecordCardFields,
  RecordCardHeader,
  RecordCardList,
  RecordCardSkeletons,
};
