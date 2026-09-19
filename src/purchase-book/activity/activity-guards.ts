import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Guardas compartidas por los dos servicios del módulo de actividad.
 *
 * Son funciones sueltas y no un servicio inyectable a propósito: no tienen
 * estado ni dependencias, reciben el `TransactionClient` de quien las llama y
 * corren dentro de la transacción que ya abrió `withTenant()`. Convertirlas en
 * un provider agregaría una inyección más para no ganar nada.
 */

/**
 * El receptor existe y es del tenant.
 *
 * `tenantId` explícito además de RLS: defensa en profundidad, igual que en el
 * resto del módulo. Todo lo que cuelga de la actividad —catálogo y mapeo— es
 * POR RECEPTOR, así que ninguna operación puede empezar sin comprobar que ese
 * contribuyente es de quien pregunta.
 */
export async function assertReceptorExists(
  tx: Prisma.TransactionClient,
  tenantId: string,
  receptorId: string,
): Promise<void> {
  const party = await tx.dteParty.findFirst({
    where: { id: receptorId, tenantId },
    select: { id: true },
  });
  if (!party) {
    throw new NotFoundException({
      error: 'DTE_PARTY_NOT_FOUND',
      message: 'Receptor no encontrado',
    });
  }
}

/**
 * La actividad existe, es del tenant, es del MISMO receptor y está activa.
 *
 * Vive acá y no en un servicio porque la comparten las dos formas de asignar
 * una actividad: el default de un proveedor y el override de un documento. Son
 * la misma regla —"esta actividad se le puede asignar a algo de este
 * contribuyente"— y una sola de las dos aplicándola sería una fuga: apuntar a
 * la actividad de otro contribuyente aplica SU criterio contable a estas
 * compras, que es exactamente lo que el modelo ternario existe para impedir.
 */
export async function assertActivityAssignableToReceptor(
  tx: Prisma.TransactionClient,
  tenantId: string,
  activityId: string,
  receptorId: string,
): Promise<void> {
  const activity = await tx.purchaseActivity.findFirst({
    where: { id: activityId, tenantId },
    select: { id: true, receptorId: true, active: true },
  });
  if (!activity) {
    throw new NotFoundException({
      error: 'PURCHASE_ACTIVITY_NOT_FOUND',
      message: 'Actividad no encontrada',
    });
  }
  if (activity.receptorId !== receptorId) {
    throw new UnprocessableEntityException({
      error: 'PURCHASE_ACTIVITY_RECEPTOR_MISMATCH',
      message:
        'La actividad pertenece a otro contribuyente. La actividad es por receptor: apuntar a la de otro aplicaría su criterio a estas compras.',
    });
  }
  if (!activity.active) {
    throw new UnprocessableEntityException({
      error: 'PURCHASE_ACTIVITY_INACTIVE',
      message: 'La actividad está desactivada: reactivala antes de asignarla',
    });
  }
}
