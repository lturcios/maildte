// Matchers de jest-dom (`toBeDisabled`, `toBeChecked`, `toBeInTheDocument`)
// registrados sobre el `expect` de Vitest.
import '@testing-library/jest-dom/vitest';

// jsdom no implementa `URL.createObjectURL` ni `URL.revokeObjectURL`. El panel
// de export las usa para disparar la descarga del archivo ya recibido, es
// decir, en un paso posterior al que verifican los tests: lo que se afirma es
// la URL que recibe `apiDownload`, que no pasa por acá. Se sustituyen por
// stubs mínimos para que el navegador simulado no rompa el flujo.
URL.createObjectURL = () => 'blob:maildte-test';
URL.revokeObjectURL = () => undefined;

// jsdom tampoco implementa la Pointer Events API ni `scrollIntoView`, y los
// componentes de Radix que abren un panel flotante (Select, Dropdown) las
// llaman al recibir el click. Sin estos stubs, cualquier test que abra un
// `<Select>` muere con "target.hasPointerCapture is not a function" — un fallo
// del navegador simulado, no del componente.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => undefined;
}
