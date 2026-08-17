export interface CampaignEventInput {
  key: string;
  name: string;
  starts_at: string;
  ends_at: string;
  pity_threshold: number | null;
  is_active: boolean;
}

const KEY_PATTERN = /^[a-z0-9_]+$/;

/**
 * campaign_events の作成・更新(全項目置き換え)入力を検証する。
 * PATCHでの部分更新はis_activeの単独トグルのみ別扱いとし、それ以外は常に全項目を要求する
 * (starts_at/ends_atの前後関係チェックを部分更新と両立させないための単純化)。
 */
export function parseEventInput(body: Record<string, unknown>): { value: CampaignEventInput } | { error: string } {
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!KEY_PATTERN.test(key)) {
    return { error: 'invalid_key' };
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return { error: 'invalid_name' };
  }

  const startsAt = typeof body.starts_at === 'string' ? new Date(body.starts_at) : new Date(NaN);
  if (isNaN(startsAt.getTime())) {
    return { error: 'invalid_starts_at' };
  }

  const endsAt = typeof body.ends_at === 'string' ? new Date(body.ends_at) : new Date(NaN);
  if (isNaN(endsAt.getTime())) {
    return { error: 'invalid_ends_at' };
  }

  if (endsAt <= startsAt) {
    return { error: 'ends_at_must_be_after_starts_at' };
  }

  let pityThreshold: number | null = null;
  if (body.pity_threshold !== null && body.pity_threshold !== undefined && body.pity_threshold !== '') {
    const n = Number(body.pity_threshold);
    if (!Number.isInteger(n) || n < 1) {
      return { error: 'invalid_pity_threshold' };
    }
    pityThreshold = n;
  }

  const isActive = typeof body.is_active === 'boolean' ? body.is_active : true;

  return {
    value: {
      key,
      name,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      pity_threshold: pityThreshold,
      is_active: isActive,
    },
  };
}
