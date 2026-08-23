import { normalizeFolderName } from './normalize-folder-name';

describe('normalizeFolderName', () => {
  it('reemplaza @ y . por _ en un correo simple', () => {
    expect(normalizeFolderName('compras@ltsoft.us')).toBe('compras_ltsoft_us');
  });

  it('deja solo [a-z0-9_-] para correos con acentos y varios subdominios', () => {
    const result = normalizeFolderName('facturación.dte@empresa.com.sv');

    expect(result).toMatch(/^[a-z0-9_-]+$/);
  });

  it('convierte a minúsculas', () => {
    expect(normalizeFolderName('Compras@LTSOFT.US')).toBe('compras_ltsoft_us');
  });
});
