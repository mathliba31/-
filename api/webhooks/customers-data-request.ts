import type { VercelRequest, VercelResponse } from '@vercel/node';
import { env } from '../../lib/env';
import { verifyWebhookHmac } from '../../lib/webhookAuth';
import { readRawBody } from '../../lib/rawBody';
import { getSupabaseAdmin } from '../../lib/supabaseAdmin';

// Shopifyの必須コンプライアンスWebhook。HMAC検証のため自動JSONパースを無効化する。
export const config = {
  api: {
    bodyParser: false,
  },
};

interface CustomersDataRequestPayload {
  shop_domain: string;
  customer: { id: number | string; email?: string; phone?: string };
  data_request?: { id: number };
}

/**
 * customers/data_request: 顧客が自身のデータ開示を要求した際にShopifyから送られる。
 * 当アプリは氏名・メール・住所等の個人情報を一切保存していない
 * (保持しているのはShopify顧客IDに紐づくチケット残高・抽選履歴・クーポンのみ)。
 * そのため自動応答はここでの受付ログのみとし、開示対応(30日以内)は
 * ストアオーナーが Supabase の customers/draws/coupons/ticket_ledger を
 * shopify_customer_id で検索して行う。
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
      .insert({ shopify_event_id: eventId, topic: 'customers/data_request' });

    if (insertEventError) {
      if (insertEventError.code === '23505') {
        return res.status(200).json({ status: 'already_processed' });
      }
      console.error('webhook_events insert error', insertEventError);
      return res.status(500).json({ error: 'internal_error' });
    }
  }

  let payload: CustomersDataRequestPayload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'invalid_json' });
  }

  // ストアオーナーが後から追える形でログに残す(30日以内に開示対応が必要)。
  console.log('customers/data_request received', {
    shopify_customer_id: String(payload.customer?.id),
    data_request_id: payload.data_request?.id,
  });

  return res.status(200).json({ status: 'ok' });
}
