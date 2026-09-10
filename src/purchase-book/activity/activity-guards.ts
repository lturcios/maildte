import { NotFoundException } from '@nestjs/common';
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
