#!/usr/bin/env node
import { runInit } from './commands/init';
import { runSync } from './commands/sync';
import { runVerify } from './commands/verify';

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case 'init':
      await runInit();
      break;
    case 'sync':
      await runSync(rest);
      break;
    case 'verify':
      await runVerify(rest);
      break;
    default:
      console.error(`Comando desconocido: ${command ?? '(ninguno)'}`);
      console.error('Uso: maildte-pull <init|sync|verify> [opciones]');
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Error inesperado:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
