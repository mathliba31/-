import type { VercelRequest, VercelResponse } from '@vercel/node';
import { env } from '../../lib/env';
import { verifyAppProxySignature, getLoggedInCustomerId, type QueryParams } from '../../lib/appProxyAuth';
import { getSupabaseAdmin } from '../../lib/supabaseAdmin';
import { issueKujiCouponForDraw } from '../../lib/issueKujiCoupon';
import { sendAlertEmail } from '../../lib/alertEmail';
import type { DiscountType, PrizeInfo } from '../../lib/types';

interface DrawKujiRow {
  draw_id: string;
  prize_id: number;
  prize_name: string;
  shopify_variant_id: string;
  discount_type: DiscountType;
  discount_value: number;
  list_price: number;
  sequence_number: number | null;
  ticket_balance: number;
  already_existed: boolean;
  bonus_draw_id: string | null;
  bonus_prize_id: number | null;
  bonus_prize_name: string | null;
  bonus_shopify_variant_id: string | null;
  bonus_discount_type: DiscountType | null;
  bonus_discount_value: number | null;
  bonus_list_price: number | null;
}

function buildCheckoutUrl(code: string, variantId: string): string {
  const redirect = encodeURIComponent(`/cart/${variantId}:1`);
  return `https://${env.shopifyShopDomain}/discount/${encodeURIComponent(code)}?redirect=${redirect}`;
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

  const body = (req.body ?? {}) as { campaign?: unknown; idempotency_key?: unknown };
  const campaignKey = typeof body.campaign === 'string' ? body.campaign.trim() : '';
  if (!campaignKey) {
    return res.status(400).json({ error: 'campaign_required' });
  }
  const idempotencyKey = typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : '';
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'idempotency_key_required' });
  }

  const supabase = getSupabaseAdmin();

  const { data: campaign } = await supabase.from('kuji_campaigns').select('id').eq('key', campaignKey).maybeSingle();
  if (!campaign) {
    return res.status(404).json({ error: 'campaign_not_found' });
  }

  const { data, error } = await supabase.rpc('draw_kuji', {
    p_campaign_id: campaign.id,
    p_customer_id: customerId,
    p_idempotency_key: idempotencyKey,
  });

  if (error) {
    if (error.message.includes('INSUFFICIENT_BALANCE') || error.message.includes('CUSTOMER_NOT_FOUND')) {
      return res.status(400).json({ error: 'insufficient_balance' });
    }
    if (error.message.includes('CAMPAIGN_NOT_ACTIVE')) {
      return res.status(400).json({ error: 'campaign_not_active' });
    }
    if (error.message.includes('NO_PRIZE_AVAILABLE')) {
      await sendAlertEmail(
        '一番くじ: 景品在庫切れで抽選不能(要対応)',
        `キャンペーンID: ${campaign.id}\n顧客ID: ${customerId}\n選出可能な景品が無いため抽選が成立しませんでした。プライズ設定を確認してください。`,
      );
      return res.status(500).json({ error: 'no_prize_available' });
    }
    console.error('draw_kuji rpc error', error);
    await sendAlertEmail('一番くじ抽選処理でエラー', `キャンペーンID: ${campaign.id}\n顧客ID: ${customerId}\nerror: ${error.message}`);
    return res.status(500).json({ error: 'internal_error' });
  }

  const row = (Array.isArray(data) ? data[0] : data) as DrawKujiRow | undefined;
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

  const { data: existingCoupon } = await supabase
    .from('kuji_coupons')
    .select('code, expires_at')
    .eq('kuji_draw_id', row.draw_id)
    .maybeSingle();

  let coupon: { code: string; expiresAt: string } | null = existingCoupon
    ? { code: existingCoupon.code, expiresAt: existingCoupon.expires_at }
    : null;
  if (!coupon) {
    try {
      const issued = await issueKujiCouponForDraw({ supabase, kujiDrawId: row.draw_id, shopifyCustomerId: customerId, prize });
      coupon = { code: issued.code, expiresAt: issued.expiresAt };
    } catch (err) {
      console.error('kuji coupon issuance failed', err);
      await sendAlertEmail(
        '一番くじ: クーポン発行に失敗(要対応)',
        `顧客はくじ券を消費済みですがクーポンが未発行です。\n` +
          `顧客ID: ${customerId}\n抽選ID: ${row.draw_id}\n` +
          `error: ${err instanceof Error ? err.message : 'unknown'}`,
      );
      coupon = null;
    }
  }

  if (!coupon) {
    // 抽選(くじ券消費)は既に成立済み。クライアントは同じidempotency_keyで再試行することで
    // クーポン発行だけを再実行できる(節目賞ボーナスがあっても、通常側が未発行の間は
    // ボーナスの発行をここでは試みない。再試行時に両方まとめて処理される)。
    return res.status(502).json({
      error: 'coupon_issuance_failed',
      message: 'クーポン発行に失敗しました。同じリクエストで再試行してください。',
      draw_id: row.draw_id,
      retryable: true,
    });
  }

  let bonus: { prize: PrizeInfo; coupon: { code: string; expiresAt: string }; checkoutUrl: string } | null = null;
  if (row.bonus_draw_id && row.bonus_prize_id != null) {
    const bonusPrize: PrizeInfo = {
      id: row.bonus_prize_id,
      name: row.bonus_prize_name ?? '',
      shopifyVariantId: row.bonus_shopify_variant_id ?? '',
      discountType: (row.bonus_discount_type ?? 'free_product') as DiscountType,
      discountValue: row.bonus_discount_value ?? 0,
      listPrice: row.bonus_list_price ?? 0,
    };

    const { data: existingBonusCoupon } = await supabase
      .from('kuji_coupons')
      .select('code, expires_at')
      .eq('kuji_draw_id', row.bonus_draw_id)
      .maybeSingle();

    let bonusCoupon: { code: string; expiresAt: string } | null = existingBonusCoupon
      ? { code: existingBonusCoupon.code, expiresAt: existingBonusCoupon.expires_at }
      : null;
    if (!bonusCoupon) {
      try {
        const issued = await issueKujiCouponForDraw({
          supabase,
          kujiDrawId: row.bonus_draw_id,
          shopifyCustomerId: customerId,
          prize: bonusPrize,
        });
        bonusCoupon = { code: issued.code, expiresAt: issued.expiresAt };
      } catch (err) {
        // ボーナス側のクーポン発行失敗は通常側の結果を止めない。アラートのみ送り、
        // 後で /api/admin/reissue 相当の救済(find_kuji_draws_missing_coupon)で拾う。
        console.error('kuji bonus coupon issuance failed', err);
        await sendAlertEmail(
          '一番くじ: 節目賞クーポン発行に失敗(要対応)',
          `顧客ID: ${customerId}\n節目賞抽選ID: ${row.bonus_draw_id}\nerror: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    }

    if (bonusCoupon) {
      bonus = {
        prize: bonusPrize,
        coupon: bonusCoupon,
        checkoutUrl: buildCheckoutUrl(bonusCoupon.code, bonusPrize.shopifyVariantId),
      };
    }
  }

  return res.status(200).json({
    prize: { name: prize.name, list_price: prize.listPrice },
    sequence_number: row.sequence_number,
    coupon: { code: coupon.code, expires_at: coupon.expiresAt },
    checkout_url: buildCheckoutUrl(coupon.code, prize.shopifyVariantId),
    ticket_balance: row.ticket_balance,
    bonus: bonus
      ? {
          prize: { name: bonus.prize.name, list_price: bonus.prize.listPrice },
          coupon: { code: bonus.coupon.code, expires_at: bonus.coupon.expiresAt },
          checkout_url: bonus.checkoutUrl,
        }
      : null,
  });
}
