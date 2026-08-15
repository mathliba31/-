import { createHmac, timingSafeEqual } from 'crypto';

export type QueryParams = Record<string, string | string[] | undefined>;

/**
 * Shopify App Proxy の signature を検証する。
 *
 * 手順:
 *   1. クエリパラメータから signature を除外する
 *   2. 残りをキー名の昇順にソートし、`key=value` を区切り文字なしで連結する
 *      (同じキーが複数ある場合は値をカンマ区切りで連結する)
 *   3. secret をキーに HMAC-SHA256 を計算する
 *   4. 16進文字列を signature とタイミングセーフに比較する
 */
export function verifyAppProxySignature(query: QueryParams, secret: string): boolean {
  const signature = query.signature;
  if (!signature || Array.isArray(signature)) {
    return false;
  }

  const keys = Object.keys(query)
    .filter((key) => key !== 'signature')
    .sort();

  const message = keys
    .map((key) => {
      const value = query[key];
      const joined = Array.isArray(value) ? value.join(',') : value ?? '';
      return `${key}=${joined}`;
    })
    .join('');

  const digest = createHmac('sha256', secret).update(message, 'utf8').digest('hex');

  const digestBuf = Buffer.from(digest, 'utf8');
  const signatureBuf = Buffer.from(signature, 'utf8');
  if (digestBuf.length !== signatureBuf.length) {
    return false;
  }
  return timingSafeEqual(digestBuf, signatureBuf);
}

/**
 * signature検証後、logged_in_customer_id からShopify顧客IDを取得する。
 * リクエストボディの値は改ざん可能なため絶対に使わないこと。
 * 空の場合は未ログインなのでnullを返す(呼び出し側で401にする)。
 */
export function getLoggedInCustomerId(query: QueryParams): string | null {
  const value = query.logged_in_customer_id;
  if (!value || Array.isArray(value) || value.trim() === '') {
    return null;
  }
  return value.trim();
}
