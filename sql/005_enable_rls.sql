-- 全テーブルでRow Level Securityを有効化する。
-- ポリシーは追加しないため anon/authenticated からのアクセスは完全に遮断される。
-- バックエンド(Vercel Functions)は service_role キーを使うため、RLSは常にバイパスされ動作に影響しない。
alter table public.customers        enable row level security;
alter table public.ticket_ledger    enable row level security;
alter table public.prizes           enable row level security;
alter table public.draws            enable row level security;
alter table public.coupons          enable row level security;
alter table public.weekly_counters  enable row level security;
alter table public.webhook_events   enable row level security;
alter table public.ticket_products  enable row level security;
alter table public.settings         enable row level security;
