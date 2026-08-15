import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Shopify Webhook の X-Shopify-Hmac-Sha256 を検証する。
 * rawBody は body parser を通す前の生のリクエストボディである必要がある
 * (JSON.stringify した再構築版では署名が一致しない)。
 */
export function verifyWebhookHmac(rawBody: Buffer | string, hmacHeader: string | undefined, secret: string): boolean {
  if (!hmacHeader) {
    return false;
  }

  const digest = createHmac('sha256', secret).update(rawBody).digest('base64');

  const digestBuf = Buffer.from(digest, 'utf8');
  const headerBuf = Buffer.from(hmacHeader, 'utf8');
  if (digestBuf.length !== headerBuf.length) {
    return false;
  }
  return timingSafeEqual(digestBuf, headerBuf);
}
