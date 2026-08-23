export function authFailKey(accountId: string): string {
  return `auth-fail:${accountId}`;
}
