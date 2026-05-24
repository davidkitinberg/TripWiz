import { getIdToken } from './auth';

// Bootstrap whitelist — must mirror backend ADMIN_EMAILS env var.
// Used so the first admin can sign in before being added to the Cognito Admins group.
export const ADMIN_EMAILS = new Set([
  'davidkitinberg@gmail.com',
]);

const ADMIN_GROUP = 'Admins';

function decodeJwtPayload(token) {
  try {
    const part = token.split('.')[1];
    const padded = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(padded);
    return JSON.parse(decodeURIComponent(escape(json)));
  } catch {
    return null;
  }
}

export async function getCurrentUserClaims() {
  const token = await getIdToken();
  if (!token) return null;
  return decodeJwtPayload(token);
}

export async function isCurrentUserAdmin() {
  const claims = await getCurrentUserClaims();
  if (!claims) return false;
  const groups = claims['cognito:groups'];
  if (Array.isArray(groups) && groups.includes(ADMIN_GROUP)) return true;
  const email = (claims.email || '').toLowerCase();
  return !!(email && ADMIN_EMAILS.has(email));
}
