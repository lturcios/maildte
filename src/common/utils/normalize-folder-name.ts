export function normalizeFolderName(email: string): string {
  return email
    .toLowerCase()
    .replace(/[@.]/g, '_')
    .replace(/[^a-z0-9_-]/g, '');
}
