import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface PaginationProps {
  page: number;
  limit: number;
  total: number;
  onPageChange: (page: number) => void;
}

/**
 * Paginación simple prev/next hecha a mano: el registry de shadcn/ui no
 * expone un componente `pagination` en esta versión y el caso de uso acá
 * (avanzar/retroceder página con "mostrando X–Y de N") no justifica traer
 * una librería nueva.
 *
 * En mobile los dos botones se reparten el ancho completo (área táctil real,
 * pulgar en la parte baja de la pantalla) y el contador de registros se apila
 * arriba; a partir de `sm` vuelve a la fila única de escritorio.
 */
export function Pagination({ page, limit, total, onPageChange }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);

  return (
    <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <span className="text-center text-sm text-muted-foreground sm:text-left">
        Mostrando {from}–{to} de {total}
      </span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="flex-1 sm:flex-none"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeftIcon className="size-4" aria-hidden="true" />
          Anterior
        </Button>
        <span className="shrink-0 text-sm text-muted-foreground">
          {page} / {totalPages}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="flex-1 sm:flex-none"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Siguiente
          <ChevronRightIcon className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
