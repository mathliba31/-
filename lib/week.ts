// draw_gacha() のSQL側と同じロジックで週の開始日(UTC, YYYY-MM-DD)を計算する。
// week_start_weekday: 1=月曜 ... 7=日曜 (ISO)
export function computeWeekStart(now: Date, weekStartWeekday: number): string {
  const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const isoDow = utc.getUTCDay() === 0 ? 7 : utc.getUTCDay(); // JSは0=日曜なのでISOに変換
  const offset = ((isoDow - weekStartWeekday + 7) % 7);
  utc.setUTCDate(utc.getUTCDate() - offset);
  return utc.toISOString().slice(0, 10);
}
