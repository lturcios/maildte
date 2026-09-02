import { domainOfEmail, lookupMxExchanges, matchesMxSuffix } from './mx-lookup';

describe('domainOfEmail', () => {
  it('extrae el dominio en minúsculas', () => {
    expect(domainOfEmail('Compras@LTSoft.US')).toBe('ltsoft.us');
  });

  it('recorta espacios alrededor de la dirección', () => {
    expect(domainOfEmail('  compras@ltsoft.us  ')).toBe('ltsoft.us');
  });

  it('devuelve null si no hay exactamente una arroba', () => {
    expect(domainOfEmail('sin-arroba')).toBeNull();
    expect(domainOfEmail('dos@arrobas@ejemplo.com')).toBeNull();
  });

  it('devuelve null si el dominio está vacío', () => {
    expect(domainOfEmail('compras@')).toBeNull();
  });
});

describe('matchesMxSuffix', () => {
  it('acepta el dominio exacto', () => {
    expect(matchesMxSuffix('google.com', 'google.com')).toBe(true);
  });

  it('acepta un subdominio real', () => {
    expect(matchesMxSuffix('aspmx.l.google.com', 'google.com')).toBe(true);
    expect(matchesMxSuffix('empresa-com.mail.protection.outlook.com', 'outlook.com')).toBe(true);
  });

  it('RECHAZA un dominio que solo termina en las mismas letras', () => {
    // Sin el punto de separación, "notgoogle.com" matchearía "google.com" y se
    // enviarían las credenciales del cliente al servidor equivocado.
    expect(matchesMxSuffix('notgoogle.com', 'google.com')).toBe(false);
    expect(matchesMxSuffix('mailgoogle.com', 'google.com')).toBe(false);
  });

  it('normaliza el sufijo a minúsculas', () => {
    expect(matchesMxSuffix('aspmx.l.google.com', 'GOOGLE.COM')).toBe(true);
  });
});

describe('lookupMxExchanges', () => {
  it('devuelve lista vacía para un dominio inexistente, sin lanzar', async () => {
    const result = await lookupMxExchanges('dominio-que-no-existe-maildte-test.invalid', 2_000);

    expect(result).toEqual([]);
  });

  it('respeta el techo de tiempo y devuelve vacío en vez de colgar el alta', async () => {
    const startedAt = Date.now();

    const result = await lookupMxExchanges('example.com', 1);

    expect(result).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });
});
