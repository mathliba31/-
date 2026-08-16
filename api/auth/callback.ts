import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '../../lib/env';

// 一時的なブートストラップ用エンドポイント。
// このDev DashboardアプリはOAuthインストール型のため、Admin APIアクセストークンは
// 管理画面には表示されず、OAuthコールバックでの code -> access_token 交換でのみ取得できる。
// SHOPIFY_ADMIN_TOKEN を一度取得してVercelの環境変数に設定したら、
// このファイルは削除し、shopify.app.toml の redirect_urls からも外すこと
// (アクセストークンをそのままレスポンスに表示するため、恒久的に残すのは危険)。

type QueryParams = Record<string, string | string[] | undefined>;

function verifyOAuthCallbackHmac(query: QueryParams, secret: string): boolean {
  const hmac = query.hmac;
  if (!hmac || Array.isArray(hmac)) {
    return false;
  }

  const keys = Object.keys(query)
    .filter((key) => key !== 'hmac' && key !== 'signature')
    .sort();

  const message = keys
    .map((key) => {
      const value = query[key];
      return `${key}=${Array.isArray(value) ? value.join(',') : value ?? ''}`;
    })
    .join('&');

  const digest = createHmac('sha256', secret).update(message, 'utf8').digest('hex');

  const digestBuf = Buffer.from(digest, 'utf8');
  const hmacBuf = Buffer.from(hmac, 'utf8');
  if (digestBuf.length !== hmacBuf.length) {
    return false;
  }
  return timingSafeEqual(digestBuf, hmacBuf);
}

interface AccessTokenResponse {
  access_token: string;
  scope: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const query = req.query as QueryParams;

  if (!verifyOAuthCallbackHmac(query, env.shopifyApiSecret)) {
    return res.status(401).send('invalid hmac');
  }

  const shop = query.shop;
  const code = query.code;
  if (!shop || Array.isArray(shop) || !code || Array.isArray(code)) {
    return res.status(400).send('missing shop or code');
  }

  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.shopifyClientId,
      client_secret: env.shopifyApiSecret,
      code,
    }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    return res.status(502).send(`token exchange failed: ${text}`);
  }

  const tokenData = (await tokenRes.json()) as AccessTokenResponse;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(
    `<pre>
このアクセストークンを SHOPIFY_ADMIN_TOKEN としてVercelに設定してください。
コピーしたら、このエンドポイント(api/auth/callback.ts)は削除して再デプロイしてください。

access_token: ${tokenData.access_token}
scope: ${tokenData.scope}
</pre>`,
  );
}
