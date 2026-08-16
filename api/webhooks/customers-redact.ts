import type { VercelRequest, VercelResponse } from '@vercel/node';
import { env } from '../../lib/env';
import { verifyWebhookHmac } from '../../lib/webhookAuth';
import { readRawBody } from '../../lib/rawBody';
import { getSupabaseAdmin } from '../../lib/supabaseAdmin';

export const config = {
  api: {
    bodyParser: false,
  },
};

interface CustomersRedactPayload {
  shop_domain: string;
  customer: { id: number | string; email?: string; phone?: string };
}

/**
 * customers/redact: ストアオーナーが特定顧客のデータ削除をリクエストしてから
 * 一定期間後にShopifyから送られる。
 * 当アプリは氏名・メール・住所等の個人情報を保存していない
 * (customers/draws/coupons/ticket_ledger は Shopify顧客ID・チケット残高・
 * 抽選履歴・クーポンコードのみで、これら自体は削除対象の「個人情報」に当たらない)。
 * そのため追加の削除処理なしで受領確認のみ返す。
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const rawBody = await readRawBody(req);
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const hmacValue = Array.isArray(hmacHeader) ? hmacHeader[0] : hmacHeader;

  if (!verifyWebhookHmac(rawBody, hmacValue, env.shopifyApiSecret)) {
    return res.status(401).json({ error: 'invalid_hmac' });
  }

  const eventIdHeader = req.headers['x-shopify-event-id'];
  const eventId = Array.isArray(eventIdHeader) ? eventIdHeader[0] : eventIdHeader;

  const supabase = getSupabaseAdmin();

  if (eventId) {
    const { error: insertEventError } = await supabase
      .from('webhook_events')
      .insert({ shopify_event_id: eventId, topic: 'customers/redact' });

    if (insertEventError) {
      if (insertEventError.code === '23505') {
        return res.status(200).json({ status: 'already_processed' });
      }
      console.error('webhook_events insert error', insertEventError);
      return res.status(500).json({ error: 'internal_error' });
    }
  }

  let payload: CustomersRedactPayload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'invalid_json' });
  }

  console.log('customers/redact received (no PII stored, no action needed)', {
    shopify_customer_id: String(payload.customer?.id),
  });

  return res.status(200).json({ status: 'ok' });
}
