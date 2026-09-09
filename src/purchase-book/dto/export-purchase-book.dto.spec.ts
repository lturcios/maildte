import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ExportPurchaseBookDto } from './export-purchase-book.dto';
import { ListPurchaseDocumentsDto } from './list-purchase-documents.dto';

/**
 * Esta suite existe porque un `@IsOptional()` heredado desactivó en silencio la
 * validación obligatoria de `receptorId` en el export: `class-validator` registra
 * `@IsOptional()` como metadato condicional de la propiedad y lo sigue aplicando
 * en la subclase, así que redeclarar la propiedad con `@IsUUID()` no alcanza para
 * volverla obligatoria. El resultado era un Anexo 3 sin receptor, fiscalmente
 * inválido, sin ningún error visible.
 *
 * Los casos de abajo custodian el límite entre los dos DTO: obligatorio en el
 * export, opcional en el listado. Romper cualquiera de los dos lados falla acá.
 *
 * Las opciones de `validateSync` replican las del `ValidationPipe` global.
 */
const PIPE_OPTIONS = { whitelist: true, forbidNonWhitelisted: true } as const;

/** UUID v4 real: `@IsUUID()` sin versión valida version y variant, no solo la forma. */
const RECEPTOR_ID = 'a1b2c3d4-5566-4788-89aa-bbccddeeff00';

describe('ExportPurchaseBookDto', () => {
  it('rechaza un export sin receptorId', () => {
    const dto = plainToInstance(ExportPurchaseBookDto, { format: 'csv', month: '2026-05' });

    const errors = validateSync(dto, PIPE_OPTIONS);

    expect(errors.map((error) => error.property)).toContain('receptorId');
  });

  it('rechaza un receptorId que no es UUID', () => {
    const dto = plainToInstance(ExportPurchaseBookDto, {
      format: 'csv',
      receptorId: 'no-es-uuid',
    });

    const errors = validateSync(dto, PIPE_OPTIONS);
    const receptorError = errors.find((error) => error.property === 'receptorId');

    expect(receptorError).toBeDefined();
    expect(Object.values(receptorError?.constraints ?? {})).toContain(
      'receptorId debe ser un UUID válido',
    );
  });

  it('acepta un receptorId válido con un formato válido', () => {
    const dto = plainToInstance(ExportPurchaseBookDto, {
      format: 'xlsx',
      receptorId: RECEPTOR_ID,
      month: '2026-05',
    });

    expect(validateSync(dto, PIPE_OPTIONS)).toEqual([]);
  });
});

describe('ListPurchaseDocumentsDto', () => {
  it('acepta un listado sin receptorId', () => {
    // El listado sigue siendo opcional: corregir el export no puede romper la
    // pantalla, donde "todos los receptores" es un filtro legítimo.
    const dto = plainToInstance(ListPurchaseDocumentsDto, { month: '2026-05' });

    expect(validateSync(dto, PIPE_OPTIONS)).toEqual([]);
  });
});
