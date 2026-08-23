export interface AccountSyncResult {
  accountLabel: string;
  nuevos: number;
  yaExistentes: number;
  descargados: number;
  fallidos: number;
  bytes: number;
  estrategia: string;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function printAccountResult(result: AccountSyncResult): void {
  console.log(`\nCuenta: ${result.accountLabel}`);
  console.log(`  Estrategia: ${result.estrategia}`);
  console.log(
    `  Nuevos: ${result.nuevos} | Ya existentes: ${result.yaExistentes} | ` +
      `Descargados: ${result.descargados} | Fallidos: ${result.fallidos}`,
  );
  console.log(`  Tamaño descargado: ${formatBytes(result.bytes)}`);
}

export function printSummary(results: AccountSyncResult[]): void {
  const totalDescargados = results.reduce((acc, r) => acc + r.descargados, 0);
  const totalFallidos = results.reduce((acc, r) => acc + r.fallidos, 0);
  console.log('\nResumen general:');
  console.log(`  Cuentas procesadas: ${results.length}`);
  console.log(`  Archivos descargados: ${totalDescargados}`);
  console.log(`  Errores: ${totalFallidos}`);
  console.log(
    totalFallidos === 0
      ? '\nListo, sin errores.'
      : '\nTerminado con errores. Revisá el detalle arriba.',
  );
}
