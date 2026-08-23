import { ManifestEntry } from './types';

export type DownloadStrategy = 'individual' | 'zip';

export const ZIP_THRESHOLD = 200;

/** --all siempre usa ZIP por mes (RF-07.9); si no, el umbral de cantidad decide. */
export function decideStrategy(pendingCount: number, isFullSync: boolean): DownloadStrategy {
  if (isFullSync) return 'zip';
  return pendingCount > ZIP_THRESHOLD ? 'zip' : 'individual';
}

/** relativePath = {folderName}/{YYYY-MM}/{json|pdf}/{archivo} — el mes es el segundo segmento. */
export function groupByMonth(entries: ManifestEntry[]): Map<string, ManifestEntry[]> {
  const groups = new Map<string, ManifestEntry[]>();
  for (const entry of entries) {
    const month = entry.relativePath.split('/')[1] ?? 'desconocido';
    const list = groups.get(month);
    if (list) {
      list.push(entry);
    } else {
      groups.set(month, [entry]);
    }
  }
  return groups;
}
