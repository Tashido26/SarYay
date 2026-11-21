export const DEFAULT_ALLOWED_EMAIL = 'herozboy@gmail.com';

export function parseAllowedEmails(raw?: string | null): string[] {
  if (!raw || !raw.trim()) {
    return [DEFAULT_ALLOWED_EMAIL];
  }
  const parsed = raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  return parsed.length > 0 ? parsed : [DEFAULT_ALLOWED_EMAIL];
}

export function isEmailAuthorized(
  email: string | null | undefined,
  allowedEmails: string[] = [DEFAULT_ALLOWED_EMAIL],
): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  return allowedEmails.some((allowed) => allowed.trim().toLowerCase() === normalized);
}

export const ACCESS_DENIED_MESSAGE =
  'Access Denied: This workspace is private. Only authorized accounts can access this application.';
