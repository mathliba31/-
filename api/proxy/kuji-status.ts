import type { VercelRequest, VercelResponse } from '@vercel/node';
import { env } from '../../lib/env';
import { verifyAppProxySignature, getLoggedInCustomerId, type QueryParams } from '../../lib/appProxyAuth';
import { getSupabaseAdmin } from '../../lib/supabaseAdmin';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
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

  const campaignKeyParam = query.campaign;
  const campaignKey = typeof campaignKeyParam === 'string' ? campaignKeyParam.trim() : '';
  if (!campaignKey) {
    return res.status(400).json({ error: 'campaign_required' });
  }

  const supabase = getSupabaseAdmin();

  const { data: campaign } = await supabase
    .from('kuji_campaigns')
    .select('id, name, status, total_slots, next_sequence_number')
    .eq('key', campaignKey)
    .maybeSingle();

  if (!campaign) {
    return res.status(404).json({ error: 'campaign_not_found' });
  }

  const [{ data: settingsRow }, { data: participantRow }, { data: prizeRows }, { data: bonusRows }, { data: couponRows }] =
    await Promise.all([
      supabase.from('settings').select('value').eq('key', 'coupon_valid_days').maybeSingle(),
      supabase
        .from('kuji_participants')
        .select('ticket_balance')
        .eq('campaign_id', campaign.id)
        .eq('shopify_customer_id', customerId)
        .maybeSingle(),
      supabase
        .from('kuji_prizes')
        .select('name, list_price, total_quantity, remaining_quantity, is_bonus')
        .eq('campaign_id', campaign.id)
        .eq('is_active', true)
        .order('id'),
      supabase
        .from('kuji_bonus_rules')
        .select('trigger_type, trigger_value, granted_at')
        .eq('campaign_id', campaign.id)
        .eq('is_active', true)
        .order('trigger_value'),
      supabase
        .from('kuji_coupons')
        .select('code, expires_at, status, kuji_draws!inner(kind, sequence_number, kuji_prizes!inner(name))')
        .eq('shopify_customer_id', customerId)
        .eq('kuji_draws.campaign_id', campaign.id)
        .order('id', { ascending: false })
        .limit(10),
    ]);

  const couponValidDays = settingsRow ? Number(settingsRow.value) || 14 : 14;

  const prizes = prizeRows ?? [];
  const slotsRemaining = prizes.filter((p) => !p.is_bonus).reduce((sum, p) => sum + p.remaining_quantity, 0);

  type CouponJoinRow = {
    code: string;
    expires_at: string;
    status: string;
    kuji_draws:
      | { kind: string; sequence_number: number | null; kuji_prizes: { name: string } | { name: string }[] }
      | { kind: string; sequence_number: number | null; kuji_prizes: { name: string } | { name: string }[] }[];
  };

  const recentCoupons = ((couponRows ?? []) as unknown as CouponJoinRow[]).map((c) => {
    const draw = Array.isArray(c.kuji_draws) ? c.kuji_draws[0] : c.kuji_draws;
    const prize = draw ? (Array.isArray(draw.kuji_prizes) ? draw.kuji_prizes[0] : draw.kuji_prizes) : undefined;
    return {
      code: c.code,
      prize_name: prize?.name ?? null,
      kind: draw?.kind ?? 'draw',
      sequence_number: draw?.sequence_number ?? null,
      expires_at: c.expires_at,
      status: c.status,
    };
  });

  return res.status(200).json({
    campaign: {
      key: campaignKey,
      name: campaign.name,
      status: campaign.status,
      total_slots: campaign.total_slots,
      slots_remaining: slotsRemaining,
      slots_drawn: campaign.next_sequence_number - 1,
    },
    ticket_balance: participantRow?.ticket_balance ?? 0,
    coupon_valid_days: couponValidDays,
    prizes: prizes
      .filter((p) => !p.is_bonus)
      .map((p) => ({
        name: p.name,
        list_price: p.list_price,
        total_quantity: p.total_quantity,
        remaining_quantity: p.remaining_quantity,
      })),
    bonus_rules: (bonusRows ?? []).map((b) => ({
      trigger_type: b.trigger_type,
      trigger_value: b.trigger_value,
      granted: b.granted_at !== null,
    })),
    recent_coupons: recentCoupons,
  });
}
