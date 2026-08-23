import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { CONFIG_FILENAME, saveConfig } from '../lib/config';
import { ApiClient } from '../lib/api-client';
import { CliConfig } from '../lib/types';

export interface CommandOptions {
  cwd?: string;
}

export async function runInit(options: CommandOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    console.log('Configuración de maildte-pull\n');
    const apiUrl = (
      await rl.question('URL de la API (ej. https://maildte.ltsoft.us/api/v1): ')
    ).trim();
    const apiKey = (await rl.question('API Key: ')).trim();
    const destDirAnswer = (await rl.question('Carpeta destino [./maildte-data]: ')).trim();
    const destDir = destDirAnswer || './maildte-data';

    console.log('\nConsultando cuentas disponibles...');
    const client = new ApiClient(apiUrl, apiKey);
    const accounts = await client.listAccounts();

    if (accounts.length === 0) {
      console.error('No hay cuentas configuradas en el servidor.');
      process.exitCode = 1;
      return;
    }

    console.log('\nCuentas disponibles:');
    accounts.forEach((a, i) => console.log(`  [${i + 1}] ${a.alias} (${a.email})`));
    const selection = (
      await rl.question(
        '\nSeleccioná las cuentas a sincronizar (números separados por coma, o "todas"): ',
      )
    ).trim();

    const selected =
      selection.toLowerCase() === 'todas'
        ? accounts
        : selection
            .split(',')
            .map((s) => Number.parseInt(s.trim(), 10))
            .filter((n) => Number.isInteger(n) && n >= 1 && n <= accounts.length)
            .map((n) => accounts[n - 1]);

    if (selected.length === 0) {
      console.error('No se seleccionó ninguna cuenta válida.');
      process.exitCode = 1;
      return;
    }

    const config: CliConfig = {
      apiUrl,
      apiKey,
      destDir,
      accounts: selected.map((a) => ({ id: a.id, alias: a.alias, email: a.email })),
    };
    saveConfig(config, cwd);

    console.log(`\nListo. Se guardó ${CONFIG_FILENAME} con ${selected.length} cuenta(s) configurada(s).`);
    console.log(`Los archivos se guardarán en: ${destDir}`);
  } finally {
    rl.close();
  }
}
