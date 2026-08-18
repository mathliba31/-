import type { VercelRequest, VercelResponse } from '@vercel/node';
import { env } from '../../lib/env';
import { verifyWebhookHmac } from '../../lib/webhookAuth';
import { readRawBody } from '../../lib/rawBody';
import { getSupabaseAdmin } from '../../lib/supabaseAdmin';

// HMAC検証には生ボディが必要なため、Vercelの自動JSONパースを無効化する。
export const config = {
  api: {
    bodyParser: false,
  },
};

interface ShopifyLineItem {
  variant_id: number | string | null;
  quantity: number;
}

interface ShopifyDiscountCode {
  code: string;
}

interface ShopifyOrderPaidPayload {
  id: number | string;
  customer?: { id: number | string } | null;
  line_items?: ShopifyLineItem[];
  discount_codes?: ShopifyDiscountCode[];
}

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
  const topicHeader = req.headers['x-shopify-topic'];
  const topic = Array.isArray(topicHeader) ? topicHeader[0] : topicHeader ?? 'orders/paid';

  const supabase = getSupabaseAdmin();

  if (eventId) {
    const { error: insertEventError } = await supabase
      .from('webhook_events')
      .insert({ shopify_event_id: eventId, topic });

    if (insertEventError) {
      // 一意制約違反 = 処理済みイベント。200を返して終了する。
      if (insertEventError.code === '23505') {
        return res.status(200).json({ status: 'already_processed' });
      }
      console.error('webhook_events insert error', insertEventError);
      return res.status(500).json({ error: 'internal_error' });
    }
  }

  let payload: ShopifyOrderPaidPayload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'invalid_json' });
  }

  const orderId = String(payload.id);
  const customerId = payload.customer?.id != null ? String(payload.customer.id) : null;

  // TODO(debug): チケット未付与の原因調査用の一時ログ。原因判明後に削除する。
  console.log('orders-paid debug', {
    orderId,
    customerId,
    lineItems: (payload.line_items ?? []).map((i) => ({ variant_id: i.variant_id, quantity: i.quantity })),
  });

  // 3. チケット付与
  if (customerId && payload.line_items?.length) {
    const { data: ticketProducts } = await supabase
      .from('ticket_products')
      .select('shopify_variant_id, ticket_count');

    const ticketCountByVariant = new Map((ticketProducts ?? []).map((t) => [t.shopify_variant_id, t.ticket_count]));

    let totalTickets = 0;
    for (const item of payload.line_items) {
      if (item.variant_id == null) continue;
      const perUnit = ticketCountByVariant.get(String(item.variant_id));
      if (perUnit) {
        totalTickets += perUnit * item.quantity;
      }
    }

    console.log('orders-paid debug: totalTickets', totalTickets);

    if (totalTickets > 0) {
      const { error: grantError } = await supabase.rpc('grant_tickets', {
        p_customer_id: customerId,
        p_delta: totalTickets,
        p_ref_id: orderId,
      });
      if (grantError) {
        console.error('grant_tickets rpc error', grantError);
        return res.status(500).json({ error: 'internal_error' });
      }
    }
  }

  // 4. クーポン使用の記録(効果測定の生命線)
  const discountCodes = payload.discount_codes ?? [];
  for (const dc of discountCodes) {
    if (!dc.code) continue;
    const { error: updateError } = await supabase
      .from('coupons')
      .update({ status: 'used', used_at: new Date().toISOString(), shopify_order_id: orderId })
      .eq('code', dc.code)
      .is('used_at', null);
    if (updateError) {
      console.error('coupon usage update error', updateError);
    }
  }

  return res.status(200).json({ status: 'ok' });
}
