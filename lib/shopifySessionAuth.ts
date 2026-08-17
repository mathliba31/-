import { createHmac, timingSafeEqual } from 'crypto';
import type { VercelRequest } from '@vercel/node';
import { env } from './env';

// Shopify App Bridge のセッショントークン(JWT, HS256)を検証する。
// 埋め込み管理画面(api/admin-ui.ts)からのAPIリクエストが、対象ショップの
// Shopify管理画面セッション内から送られたものであることを確認するために使う。
// ライブラリを増やさず crypto のみで検証する(署名検証の考え方はwebhook/appProxyと同じ)。
interface SessionTokenPayload {
  iss: string;
  dest: string;
  aud: string;
  sub: string;
  exp: number;
  nbf?: number;
  iat: number;
  jti: string;
  sid: string;
}

function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * VercelRequestからセッショントークンを検証する。不正な場合は例外を投げる。
 */
export function requireSessionToken(req: VercelRequest): SessionTokenPayload {
  const header = req.headers.authorization;
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!token) {
    throw new Error('MISSING_SESSION_TOKEN');
  }

  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error('INVALID_TOKEN_FORMAT');
  }
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const expectedSig = createHmac('sha256', env.shopifyApiSecret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  const actualSig = base64UrlDecode(signatureB64);
  if (expectedSig.length !== actualSig.length || !timingSafeEqual(expectedSig, actualSig)) {
    throw new Error('INVALID_SIGNATURE');
  }

  const payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8')) as SessionTokenPayload;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) {
    throw new Error('TOKEN_EXPIRED');
  }
  if (typeof payload.nbf === 'number' && payload.nbf > now) {
    throw new Error('TOKEN_NOT_YET_VALID');
  }
  if (payload.aud !== env.shopifyClientId) {
    throw new Error('AUD_MISMATCH');
  }

  const dest = payload.dest.replace(/^https?:\/\//, '');
  if (dest !== env.shopifyShopDomain) {
    throw new Error('SHOP_MISMATCH');
  }

  return payload;
}
