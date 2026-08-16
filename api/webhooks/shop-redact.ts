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

interface ShopRedactPayload {
  shop_domain: string;
}

/**
 * shop/redact: アプリがアンインストールされてから48時間後にShopifyから送られる。
 * この時点でストアに紐づく顧客関連データを削除する。
 *
 * 削除対象: customers / ticket_ledger / weekly_counters / draws / coupons
 *   (Shopifyの顧客・注文とのやり取りを通じて蓄積したデータのため)
 * 削除対象外: prizes / ticket_products / settings / campaign_events
 *   (運営者が手動設定した景品・運用設定であり、再インストール時にも
 *    そのまま使えるよう残す。個人情報は含まない)
 *
 * payload.shop_domain が SHOPIFY_SHOP_DOMAIN と一致する場合のみ削除を実行する
 * (別ショップ宛のリクエストを誤って処理しないための安全策)。
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
      .insert({ shopify_event_id: eventId, topic: 'shop/redact' });

    if (insertEventError) {
      if (insertEventError.code === '23505') {
        return res.status(200).json({ status: 'already_processed' });
      }
      console.error('webhook_events insert error', insertEventError);
      return res.status(500).json({ error: 'internal_error' });
    }
  }

  let payload: ShopRedactPayload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'invalid_json' });
  }

  if (payload.shop_domain !== env.shopifyShopDomain) {
    console.error('shop/redact: shop_domain mismatch, skipping deletion', payload.shop_domain);
    return res.status(200).json({ status: 'shop_mismatch_skipped' });
  }

  const { error: deleteLedgerError } = await supabase.from('ticket_ledger').delete().neq('id', -1);
  const { error: deleteWeeklyError } = await supabase.from('weekly_counters').delete().neq('shopify_customer_id', '');
  const { error: deleteCouponsError } = await supabase.from('coupons').delete().neq('id', -1);
  const { error: deleteDrawsError } = await supabase.from('draws').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  const { error: deleteCustomersError } = await supabase.from('customers').delete().neq('shopify_customer_id', '');

  const deleteError =
    deleteLedgerError || deleteWeeklyError || deleteCouponsError || deleteDrawsError || deleteCustomersError;
  if (deleteError) {
    console.error('shop/redact: deletion failed', deleteError);
    return res.status(500).json({ error: 'internal_error' });
  }

  console.log('shop/redact: customer-linked data deleted for', payload.shop_domain);
  return res.status(200).json({ status: 'ok' });
}
