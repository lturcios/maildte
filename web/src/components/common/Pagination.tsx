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
 */
export function Pagination({ page, limit, total, onPageChange }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);

  return (
    <div className="flex items-center justify-between gap-4 pt-2">
      <span className="text-sm text-muted-foreground">
        Mostrando {from}–{to} de {total}
      </span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeftIcon className="size-4" aria-hidden="true" />
          Anterior
        </Button>
        <span className="text-sm text-muted-foreground">
          Página {page} de {totalPages}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
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
