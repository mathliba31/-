-- 動作確認用のサンプルデータ。
-- shopify_variant_id は実ストアのバリアントIDに置き換えて投入すること。

insert into ticket_products (shopify_variant_id, ticket_count) values
  ('1000000000001', 1),   -- 1回券
  ('1000000000002', 10);  -- 10回券(お得パック)

insert into prizes
  (name, weight, shopify_variant_id, discount_type, discount_value, list_price, unit_cost, stock_limit, is_guaranteed_pool, is_active)
values
  ('ミニタオル(はずれ枠なし・末等)', 700, '2000000000001', 'free_product', 0,   500,  150, null, false, true),
  ('ステッカーセット',              200, '2000000000002', 'free_product', 0,  1000,  300, null, false, true),
  ('500円OFFクーポン',               70, '2000000000003', 'amount_off',  500,  500,  500, null, false, true),
  ('限定マグカップ',                 25, '2000000000004', 'free_product', 0,  3000, 1200,  200, true,  true),
  ('限定フィギュアA',                 4, '2000000000005', 'free_product', 0, 12000, 5000,   30, true,  true),
  ('限定フィギュアB(激レア)',         1, '2000000000006', 'free_product', 0, 30000, 12000,   5, true,  true);

-- 動作確認用の顧客(実運用ではWebhook経由で自動作成される)
insert into customers (shopify_customer_id, ticket_balance) values
  ('9000000000001', 3);
