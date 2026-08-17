import type { VercelRequest, VercelResponse } from '@vercel/node';
import { env } from '../../lib/env';
import { verifyAppProxySignature, getLoggedInCustomerId, type QueryParams } from '../../lib/appProxyAuth';
import { getSupabaseAdmin } from '../../lib/supabaseAdmin';

interface ActiveCampaignEventRow {
  key: string;
  name: string;
  starts_at: string;
  ends_at: string;
  pity_threshold: number | null;
}

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

  const supabase = getSupabaseAdmin();

  const [{ data: settingsRows }, { data: customerRow }, { data: activeEventRows }] = await Promise.all([
    supabase.from('settings').select('key, value').in('key', ['pity_threshold', 'coupon_valid_days']),
    supabase.from('customers').select('ticket_balance').eq('shopify_customer_id', customerId).maybeSingle(),
    supabase.rpc('get_active_campaign_event'),
  ]);

  const settings = Object.fromEntries((settingsRows ?? []).map((r) => [r.key, Number(r.value)]));
  const couponValidDays = settings.coupon_valid_days ?? 14;
  const activeEvent = ((activeEventRows as ActiveCampaignEventRow[] | null) ?? [])[0] ?? null;

  let eventDrawCount = 0;
  let eventPityThreshold: number | null = null;
  if (activeEvent) {
    eventPityThreshold = activeEvent.pity_threshold ?? settings.pity_threshold ?? 7;
    const { count } = await supabase
      .from('draws')
      .select('id', { count: 'exact', head: true })
      .eq('shopify_customer_id', customerId)
      .gte('created_at', activeEvent.starts_at)
      .lte('created_at', activeEvent.ends_at);
    eventDrawCount = count ?? 0;
  }

  const [{ data: prizeRows }, { data: couponRows }] = await Promise.all([
    supabase
      .from('prizes')
      .select('name, weight, list_price, is_guaranteed_pool')
      .eq('is_active', true)
      .gt('weight', 0),
    supabase
      .from('coupons')
      .select('code, expires_at, status, draws!inner(prizes!inner(name))')
      .eq('shopify_customer_id', customerId)
      .order('id', { ascending: false })
      .limit(10),
  ]);

  const prizes = prizeRows ?? [];
  const totalWeight = prizes.reduce((sum, p) => sum + p.weight, 0);

  type CouponJoinRow = {
    code: string;
    expires_at: string;
    status: string;
    draws: { prizes: { name: string } } | { prizes: { name: string } }[];
  };

  const recentCoupons = ((couponRows ?? []) as unknown as CouponJoinRow[]).map((c) => {
    const draw = Array.isArray(c.draws) ? c.draws[0] : c.draws;
    const prize = draw ? (Array.isArray(draw.prizes) ? draw.prizes[0] : draw.prizes) : undefined;
    return {
      code: c.code,
      prize_name: prize?.name ?? null,
      expires_at: c.expires_at,
      status: c.status,
    };
  });

  return res.status(200).json({
    ticket_balance: customerRow?.ticket_balance ?? 0,
    coupon_valid_days: couponValidDays,
    event: activeEvent
      ? {
          key: activeEvent.key,
          name: activeEvent.name,
          count: eventDrawCount,
          threshold: eventPityThreshold,
          remaining: eventPityThreshold !== null ? Math.max(eventPityThreshold - eventDrawCount, 0) : null,
        }
      : null,
    prizes: prizes.map((p) => ({
      name: p.name,
      probability: totalWeight > 0 ? p.weight / totalWeight : 0,
      list_price: p.list_price,
      is_guaranteed_pool: p.is_guaranteed_pool,
    })),
    recent_coupons: recentCoupons,
  });
}
