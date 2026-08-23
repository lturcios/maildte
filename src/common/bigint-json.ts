declare global {
  interface BigInt {
    toJSON(): string;
  }
}

/**
 * JSON.stringify (Express/pino) no sabe serializar BigInt de forma nativa.
 * Prisma modela EmailAccount.uidValidity como BigInt; sin esto, cualquier
 * cuenta con uidValidity ya sincronizado revienta la respuesta HTTP y los logs.
 */
BigInt.prototype.toJSON = function (this: bigint): string {
  return this.toString();
};

export {};
