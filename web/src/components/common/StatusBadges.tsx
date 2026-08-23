import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { AccountStatus, AdminTenantStatus, EmailStatus, SyncStatus } from '@/types/domain';

/**
 * Insignias de estado por dominio. Reusan exclusivamente las variables de
 * color ya definidas en src/index.css (chart-1..5, primary, destructive,
 * muted) — sin introducir colores sueltos.
 */

const BADGE_BASE = 'gap-1.5 border font-medium';

export function AccountStatusBadge({
  status,
  lastError,
}: {
  status: AccountStatus;
  lastError?: string | null;
}) {
  if (status === 'ACTIVA') {
    return (
      <Badge
        variant="outline"
        className={cn(BADGE_BASE, 'border-chart-4/40 bg-chart-4/15 text-chart-4')}
      >
        Activa
      </Badge>
    );
  }
  if (status === 'ERROR_AUTH') {
    return (
      <Badge
        variant="outline"
        title={lastError ?? undefined}
        className={cn(BADGE_BASE, 'border-destructive/40 bg-destructive/15 text-destructive')}
      >
        Error de autenticación
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className={cn(BADGE_BASE, 'text-muted-foreground')}>
      Inactiva
    </Badge>
  );
}

export function TenantStatusBadge({ status }: { status: AdminTenantStatus }) {
  if (status === 'ACTIVO') {
    return (
      <Badge
        variant="outline"
        className={cn(BADGE_BASE, 'border-chart-4/40 bg-chart-4/15 text-chart-4')}
      >
        Activo
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className={cn(BADGE_BASE, 'border-destructive/40 bg-destructive/15 text-destructive')}
    >
      Suspendido
    </Badge>
  );
}

const SYNC_STATUS_LABEL: Record<SyncStatus, string> = {
  EJECUTANDO: 'Ejecutando',
  COMPLETADO: 'Completado',
  COMPLETADO_CON_ERRORES: 'Completado con errores',
  ERROR: 'Error',
};

export function SyncStatusBadge({ status }: { status: SyncStatus }) {
  const label = SYNC_STATUS_LABEL[status];

  if (status === 'COMPLETADO') {
    return (
      <Badge
        variant="outline"
        className={cn(BADGE_BASE, 'border-chart-4/40 bg-chart-4/15 text-chart-4')}
      >
        {label}
      </Badge>
    );
  }
  if (status === 'COMPLETADO_CON_ERRORES') {
    return (
      <Badge
        variant="outline"
        className={cn(BADGE_BASE, 'border-primary/40 bg-primary/15 text-primary')}
      >
        {label}
      </Badge>
    );
  }
  if (status === 'ERROR') {
    return (
      <Badge
        variant="outline"
        className={cn(BADGE_BASE, 'border-destructive/40 bg-destructive/15 text-destructive')}
      >
        {label}
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className={cn(BADGE_BASE, 'border-chart-2/40 bg-chart-2/15 text-chart-2')}
    >
      <span className="size-1.5 animate-pulse rounded-full bg-chart-2" aria-hidden="true" />
      {label}
    </Badge>
  );
}

const EMAIL_STATUS_LABEL: Record<EmailStatus, string> = {
  PROCESADO: 'Procesado',
  SIN_ADJUNTOS: 'Sin adjuntos',
  ERROR: 'Error',
};

export function EmailStatusBadge({ status }: { status: EmailStatus }) {
  const label = EMAIL_STATUS_LABEL[status];

  if (status === 'PROCESADO') {
    return (
      <Badge
        variant="outline"
        className={cn(BADGE_BASE, 'border-chart-4/40 bg-chart-4/15 text-chart-4')}
      >
        {label}
      </Badge>
    );
  }
  if (status === 'ERROR') {
    return (
      <Badge
        variant="outline"
        className={cn(BADGE_BASE, 'border-destructive/40 bg-destructive/15 text-destructive')}
      >
        {label}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className={cn(BADGE_BASE, 'text-muted-foreground')}>
      {label}
    </Badge>
  );
}
