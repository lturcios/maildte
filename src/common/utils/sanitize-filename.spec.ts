import { sanitizeFilename } from './sanitize-filename';

describe('sanitizeFilename', () => {
  it('neutraliza intentos de path traversal conservando la extensión', () => {
    const result = sanitizeFilename('../../etc/passwd.json');

    expect(result).not.toContain('..');
    expect(result).not.toContain('/');
    expect(result.endsWith('.json')).toBe(true);
  });

  it('remueve caracteres inválidos de filesystem', () => {
    const result = sanitizeFilename('factura:*?"<>|.pdf');

    expect(result).toBe('factura.pdf');
  });

  it('remueve caracteres de control', () => {
    const result = sanitizeFilename('factura\x00\x1f.pdf');

    expect(result).toBe('factura.pdf');
  });

  it('colapsa espacios múltiples y recorta bordes', () => {
    const result = sanitizeFilename('  factura    final  .pdf');

    expect(result).toBe('factura final.pdf');
  });

  it('trunca nombres mayores a 180 caracteres conservando la extensión', () => {
    const longName = 'a'.repeat(250) + '.pdf';

    const result = sanitizeFilename(longName);

    expect(result.length).toBe(180);
    expect(result.endsWith('.pdf')).toBe(true);
  });

  it('usa "archivo" como base cuando el nombre queda vacío tras sanitizar', () => {
    const result = sanitizeFilename('<<<>>>.pdf');

    expect(result).toBe('archivo.pdf');
  });

  it('preserva un nombre ya válido sin modificarlo', () => {
    const result = sanitizeFilename('factura_2026-08.pdf');

    expect(result).toBe('factura_2026-08.pdf');
  });
});
