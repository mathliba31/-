import type { VercelRequest } from '@vercel/node';
import { timingSafeEqual } from 'crypto';
import { env } from './env';

/** POST /api/admin/* 用の共有シークレット認証(Authorization: Bearer <ADMIN_API_SECRET>)。 */
export function isAdminAuthorized(req: VercelRequest): boolean {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (!token) return false;

  const expected = Buffer.from(env.adminApiSecret, 'utf8');
  const actual = Buffer.from(token, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
