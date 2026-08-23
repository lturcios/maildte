import { Prisma } from '@prisma/client';

export function isPrismaUniqueViolation(err: unknown, target?: string): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002' &&
    (!target || String(err.meta?.target).includes(target))
  );
}
