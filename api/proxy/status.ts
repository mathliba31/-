import type { VercelRequest, VercelResponse } from '@vercel/node';
import { env } from '../../lib/env';
import { verifyAppProxySignature, getLoggedInCustomerId, type QueryParams } from '../../lib/appProxyAuth';
import { getSupabaseAdmin } from '../../lib/supabaseAdmin';
import { computeWeekStart } from '../../lib/week';

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

  const [{ data: settingsRows }, { data: customerRow }] = await Promise.all([
    supabase
      .from('settings')
      .select('key, value')
      .in('key', ['pity_threshold', 'week_start_weekday', 'coupon_valid_days']),
    supabase.from('customers').select('ticket_balance').eq('shopify_customer_id', customerId).maybeSingle(),
  ]);

  const settings = Object.fromEntries((settingsRows ?? []).map((r) => [r.key, Number(r.value)]));
  const pityThreshold = settings.pity_threshold ?? 7;
  const weekStartWeekday = settings.week_start_weekday ?? 1;
  const couponValidDays = settings.coupon_valid_days ?? 14;
  const weekStart = computeWeekStart(new Date(), weekStartWeekday);

  const [{ data: weeklyRow }, { data: prizeRows }, { data: couponRows }] = await Promise.all([
    supabase
      .from('weekly_counters')
      .select('draw_count, guaranteed_granted')
      .eq('shopify_customer_id', customerId)
      .eq('week_start', weekStart)
      .maybeSingle(),
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

  const weeklyCount = weeklyRow?.draw_count ?? 0;
  const remaining = Math.max(pityThreshold - weeklyCount, 0);

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
    weekly: {
      count: weeklyCount,
      threshold: pityThreshold,
      remaining,
      granted: weeklyRow?.guaranteed_granted ?? false,
    },
    prizes: prizes.map((p) => ({
      name: p.name,
      probability: totalWeight > 0 ? p.weight / totalWeight : 0,
      list_price: p.list_price,
      is_guaranteed_pool: p.is_guaranteed_pool,
    })),
    recent_coupons: recentCoupons,
  });
}
