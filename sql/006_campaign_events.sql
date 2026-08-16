-- Shopify Flowのセグメント配信向け: イベント期間(キャンペーン)をDBで管理する。
-- weekly_counters(天井判定)とは独立した概念。開始・終了はSQLのinsert/updateだけで運用できる。
create table campaign_events (
  id          bigserial primary key,
  key         text not null unique,        -- Flow側で参照する短い識別子。例: 'summer_2026'
  name        text not null,                -- 表示名
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  is_active   boolean not null default true, -- 期間内でも手動で無効化したい場合に false にする
  created_at  timestamptz not null default now(),
  constraint campaign_events_period_check check (ends_at > starts_at)
);

create index on campaign_events (starts_at, ends_at) where is_active;

-- 現在有効なイベントを1件返す(複数が重複している場合は starts_at が新しい方を優先)
create or replace function get_active_campaign_event()
returns table (id bigint, key text, name text, starts_at timestamptz, ends_at timestamptz)
language sql
stable
as $$
  select id, key, name, starts_at, ends_at
  from campaign_events
  where is_active
    and now() between starts_at and ends_at
  order by starts_at desc
  limit 1;
$$;

alter table campaign_events enable row level security;
