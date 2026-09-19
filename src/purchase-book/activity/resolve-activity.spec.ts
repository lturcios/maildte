import { resolveActivity, supplierDefaultKey } from './resolve-activity';

const EMISOR = 'emisor-1';
const ACTIVITY = 'activity-1';
const OTHER_ACTIVITY = 'activity-2';

describe('resolveActivity', () => {
  it('el override del documento gana sobre el default del proveedor', () => {
    expect(resolveActivity({ activityId: ACTIVITY, emisorId: EMISOR }, OTHER_ACTIVITY)).toEqual({
      activityId: ACTIVITY,
      source: 'override',
    });
  });

  it('sin override, hereda el default del proveedor', () => {
    expect(resolveActivity({ activityId: null, emisorId: EMISOR }, ACTIVITY)).toEqual({
      activityId: ACTIVITY,
      source: 'supplier-default',
    });
  });

  it('sin override ni default queda sin clasificar', () => {
    expect(resolveActivity({ activityId: null, emisorId: EMISOR }, null)).toEqual({
      activityId: null,
      source: 'missing',
    });
  });

  it('un override sigue ganando aunque el proveedor no esté mapeado', () => {
    expect(resolveActivity({ activityId: ACTIVITY, emisorId: EMISOR }, null)).toEqual({
      activityId: ACTIVITY,
      source: 'override',
    });
  });

  it('distingue el origen, no solo el valor: el mismo id puede venir de los dos lados', () => {
    // Importa para la pantalla: "heredado del proveedor" se puede cambiar
    // mapeando el proveedor una vez; "override" hay que tocarlo documento a
    // documento. El valor no alcanza para distinguirlos.
    const heredado = resolveActivity({ activityId: null, emisorId: EMISOR }, ACTIVITY);
    const propio = resolveActivity({ activityId: ACTIVITY, emisorId: EMISOR }, ACTIVITY);

    expect(heredado.activityId).toBe(propio.activityId);
    expect(heredado.source).not.toBe(propio.source);
  });
});

describe('supplierDefaultKey', () => {
  it('la clave incluye al receptor: el default es ternario', () => {
    expect(supplierDefaultKey('r-1', EMISOR)).not.toBe(supplierDefaultKey('r-2', EMISOR));
  });

  it('no colisiona con un separador que pueda aparecer en un id', () => {
    // El mismo distribuidor le vende a varios contribuyentes del mismo buzón.
    // Una clave concatenada con un separador que aparezca en un id mezclaría
    // el criterio de dos contribuyentes distintos.
    expect(supplierDefaultKey('a-b', 'c')).not.toBe(supplierDefaultKey('a', 'b-c'));
  });
});
