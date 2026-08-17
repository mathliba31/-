import type { VercelRequest, VercelResponse } from '@vercel/node';
import { env } from '../../lib/env';
import { verifyAppProxySignature, getLoggedInCustomerId, type QueryParams } from '../../lib/appProxyAuth';
import { getSupabaseAdmin } from '../../lib/supabaseAdmin';
import { issueCouponForDraw } from '../../lib/issueCoupon';
import { syncGachaMetafields } from '../../lib/syncGachaMetafields';
import type { DiscountType, PrizeInfo } from '../../lib/types';

interface DrawGachaRow {
  draw_id: string;
  prize_id: number;
  prize_name: string;
  shopify_variant_id: string;
  discount_type: DiscountType;
  discount_value: number;
  list_price: number;
  is_guaranteed: boolean;
  ticket_balance: number;
  event_key: string | null;
  event_draw_count: number;
  event_pity_threshold: number | null;
  already_existed: boolean;
}

function buildCheckoutUrl(code: string): string {
  return `https://${env.shopifyShopDomain}/discount/${encodeURIComponent(code)}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const query = req.query as QueryParams;

  if (!verifyAppProxySignature(query, env.shopifyApiSecret)) {
    return res.status(401).json({ error: 'invalid_signature' });
  }

  const customerId = getLoggedInCustomerId(query);
  if (!customerId) {
    return res.status(401).json({ error: 'not_logged_in' });
  }

  const body = (req.body ?? {}) as { idempotency_key?: unknown };
  const idempotencyKey = typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : '';
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'idempotency_key_required' });
  }

  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase.rpc('draw_gacha', {
    p_customer_id: customerId,
    p_idempotency_key: idempotencyKey,
  });

  if (error) {
    if (error.message.includes('INSUFFICIENT_BALANCE') || error.message.includes('CUSTOMER_NOT_FOUND')) {
      return res.status(400).json({ error: 'insufficient_balance' });
    }
    if (error.message.includes('NO_PRIZE_AVAILABLE')) {
      return res.status(500).json({ error: 'no_prize_available' });
    }
    console.error('draw_gacha rpc error', error);
    return res.status(500).json({ error: 'internal_error' });
  }

  const row = (Array.isArray(data) ? data[0] : data) as DrawGachaRow | undefined;
  if (!row) {
    return res.status(500).json({ error: 'internal_error' });
  }

  const prize: PrizeInfo = {
    id: row.prize_id,
    name: row.prize_name,
    shopifyVariantId: row.shopify_variant_id,
    discountType: row.discount_type,
    discountValue: row.discount_value,
    listPrice: row.list_price,
  };

  // 既存のクーポンが発行済みかを確認する(idempotent replayと、
  // 前回クーポン発行だけ失敗したケースの両方をここで吸収する)
  const { data: existingCoupon } = await supabase
    .from('coupons')
    .select('code, expires_at')
    .eq('draw_id', row.draw_id)
    .maybeSingle();

  let coupon: { code: string; expiresAt: string } | null = existingCoupon
    ? { code: existingCoupon.code, expiresAt: existingCoupon.expires_at }
    : null;
  if (!coupon) {
    try {
      const issued = await issueCouponForDraw({
        supabase,
        drawId: row.draw_id,
        shopifyCustomerId: customerId,
        prize,
      });
      coupon = { code: issued.code, expiresAt: issued.expiresAt };
    } catch (err) {
      console.error('coupon issuance failed', err);
      // 抽選は既に成立済み。チケットは返却しない(二重消費防止)。
      // クライアントは同じ idempotency_key で再試行することでクーポン発行だけを再実行できる。
      return res.status(502).json({
        error: 'coupon_issuance_failed',
        message: 'クーポン発行に失敗しました。同じリクエストで再試行してください。',
        draw_id: row.draw_id,
        retryable: true,
      });
    }
  }

  // Shopify Flowのセグメント配信向けに顧客メタフィールドを更新する。
  // 抽選・クーポン発行はすでに成立しているため、ここが失敗してもレスポンスは正常に返す。
  try {
    await syncGachaMetafields(supabase, customerId);
  } catch (err) {
    console.error('gacha metafields sync failed', err);
  }

  return res.status(200).json({
    prize: { name: prize.name, list_price: prize.listPrice },
    is_guaranteed: row.is_guaranteed,
    coupon: { code: coupon.code, expires_at: coupon.expiresAt },
    checkout_url: buildCheckoutUrl(coupon.code),
    ticket_balance: row.ticket_balance,
    event: row.event_key
      ? {
          key: row.event_key,
          count: row.event_draw_count,
          threshold: row.event_pity_threshold,
          remaining:
            row.event_pity_threshold !== null
              ? Math.max(row.event_pity_threshold - row.event_draw_count, 0)
              : null,
        }
      : null,
  });
}
