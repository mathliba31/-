import type { VercelRequest, VercelResponse } from '@vercel/node';
import { env } from '../../lib/env';
import { verifyWebhookHmac } from '../../lib/webhookAuth';
import { readRawBody } from '../../lib/rawBody';
import { getSupabaseAdmin } from '../../lib/supabaseAdmin';
import { sendAlertEmail } from '../../lib/alertEmail';

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

  // 処理済みイベントの早期スキップ(ここでは「記録」ではなく「確認」のみ行う)。
  // 記録(insert)は処理が最後まで成功した後に行う。先に記録してしまうと、
  // この後のチケット付与などが途中で失敗したときにShopifyからの再配信が
  // 無条件に「処理済み」としてスキップされ、チケットが永久に付与されない
  // ケースが生じるため(grant_tickets自体はref_id単位で冪等になっているので、
  // 再配信のたびに処理をやり直しても二重付与はしない)。
  if (eventId) {
    const { data: existingEvent } = await supabase
      .from('webhook_events')
      .select('shopify_event_id')
      .eq('shopify_event_id', eventId)
      .maybeSingle();
    if (existingEvent) {
      return res.status(200).json({ status: 'already_processed' });
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

    if (totalTickets > 0) {
      const { error: grantError } = await supabase.rpc('grant_tickets', {
        p_customer_id: customerId,
        p_delta: totalTickets,
        p_ref_id: orderId,
      });
      if (grantError) {
        console.error('grant_tickets rpc error', grantError);
        await sendAlertEmail(
          'チケット付与に失敗(要手動対応)',
          `注文の支払いは完了していますが、チケット付与に失敗しました。\n` +
            `注文ID: ${orderId}\n顧客ID: ${customerId}\n付与予定数: ${totalTickets}\nerror: ${grantError.message}`,
        );
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
      await sendAlertEmail(
        'クーポン使用記録の更新に失敗',
        `クーポンコード: ${dc.code}\n注文ID: ${orderId}\nerror: ${updateError.message}`,
      );
    }
  }

  if (eventId) {
    const { error: insertEventError } = await supabase
      .from('webhook_events')
      .insert({ shopify_event_id: eventId, topic });
    // 一意制約違反(23505) = 同時配信されたもう一方が先に記録済み。処理自体は
    // お互いに冪等なので無視してよい。それ以外のエラーはログにだけ残し、
    // レスポンスには影響させない(処理自体は既に成功しているため)。
    if (insertEventError && insertEventError.code !== '23505') {
      console.error('webhook_events insert error', insertEventError);
    }
  }

  return res.status(200).json({ status: 'ok' });
}
