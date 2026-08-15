-- ガチャ機能: テーブル定義
-- Supabase (PostgreSQL) にそのまま適用する。

create extension if not exists pgcrypto;

-- 顧客(Shopifyの顧客IDを主キーとする。独自の会員テーブルは作らない)
create table customers (
  shopify_customer_id text primary key,
  ticket_balance      integer not null default 0 check (ticket_balance >= 0),
  created_at          timestamptz not null default now()
);

-- チケット増減の履歴(残高の監査用。残高そのものは customers に持つ)
create table ticket_ledger (
  id                  bigserial primary key,
  shopify_customer_id text not null references customers,
  delta               integer not null,
  reason              text not null,   -- 'purchase' | 'draw' | 'admin_adjust'
  ref_id              text,            -- 注文IDや抽選ID
  created_at          timestamptz not null default now()
);

-- 景品マスタ(運用中に最も頻繁に触るテーブル)
create table prizes (
  id                  bigserial primary key,
  name                text not null,
  weight              integer not null check (weight >= 0),  -- 抽選の重み。0で実質無効
  shopify_variant_id  text not null,      -- 対象商品のバリアントID
  discount_type       text not null,      -- 'free_product'(100%OFF) | 'amount_off' | 'percent_off'
  discount_value      integer not null default 0,  -- amount_off:円 / percent_off:%
  list_price          integer not null,   -- 定価。表示還元率の計算用
  unit_cost           integer not null,   -- 実質原価。損益管理用
  stock_limit         integer,            -- 発行上限。nullは無制限
  issued_count        integer not null default 0,
  is_guaranteed_pool  boolean not null default false,  -- 天井の確定枠対象か
  is_active           boolean not null default true
);

-- 抽選ログ
create table draws (
  id                  uuid primary key default gen_random_uuid(),
  shopify_customer_id text not null references customers,
  prize_id            bigint not null references prizes,
  is_guaranteed       boolean not null default false,
  idempotency_key     text not null unique,   -- 連打・二重送信の防止
  created_at          timestamptz not null default now()
);

-- 発行済みクーポン
create table coupons (
  id                  bigserial primary key,
  draw_id             uuid not null unique references draws,
  shopify_customer_id text not null,
  code                text not null unique,
  shopify_discount_id text,
  status              text not null default 'issued',  -- 'issued' | 'used' | 'expired'
  expires_at          timestamptz not null,
  used_at             timestamptz,
  shopify_order_id    text                     -- 効果測定の要。必ず埋めること
);

-- 週次カウンタ(天井判定用)
create table weekly_counters (
  shopify_customer_id text not null references customers,
  week_start          date not null,           -- 月曜始まり
  draw_count          integer not null default 0,
  guaranteed_granted  boolean not null default false,
  primary key (shopify_customer_id, week_start)
);

-- Webhookの重複配信対策(Shopifyは同一イベントを複数回送ることがある)
create table webhook_events (
  shopify_event_id    text primary key,
  topic               text not null,
  received_at         timestamptz not null default now()
);

-- チケット商品の対応表(どのバリアントを買うと何枚付与されるか)
create table ticket_products (
  shopify_variant_id  text primary key,
  ticket_count        integer not null check (ticket_count > 0)
);

-- 全体設定
create table settings (
  key   text primary key,
  value jsonb not null
);

-- 初期設定値
insert into settings (key, value) values
  ('pity_threshold',      '7'),      -- 天井までの回数
  ('coupon_valid_days',   '14'),     -- クーポン有効日数
  ('week_start_weekday',  '1');      -- 1 = 月曜

-- インデックス
create index on draws (shopify_customer_id, created_at desc);
create index on coupons (shopify_customer_id, status);
create index on coupons (code);
create index on ticket_ledger (shopify_customer_id, created_at desc);
