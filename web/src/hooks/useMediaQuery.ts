import { useSyncExternalStore } from 'react';

/**
 * Suscripción a una media query del navegador.
 *
 * Se usa `useSyncExternalStore` en vez de `useState` + `useEffect` porque
 * `matchMedia` ES una fuente externa: el valor se lee en el mismo render (sin el
 * parpadeo de un primer render con el valor por defecto) y React se encarga de
 * la suscripción y su limpieza.
 *
 * Es la salida cuando el breakpoint tiene que cambiar COMPORTAMIENTO, no solo
 * estilo: para lo puramente visual siempre gana una clase `md:` de Tailwind, que
 * no depende de JS ni re-renderiza.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onStoreChange);
      return () => list.removeEventListener('change', onStoreChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Breakpoint `md` de Tailwind: el mismo punto en el que la app pasa de cards a tablas. */
export function useIsDesktop(): boolean {
  return useMediaQuery('(min-width: 48rem)');
}
