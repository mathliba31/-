# Shopify ガチャアプリ

Shopifyストア向けの有料ガチャ機能。抽選はサーバー(Vercel Functions)で行い、
確率・価格・景品はすべてSupabase(PostgreSQL)の値として持つ。景品はすべて
Shopifyの割引コードとして発行し、決済・在庫・配送はShopifyの通常フローに任せる。

## 構成

| レイヤ | 採用技術 |
|---|---|
| フロントエンド | `theme/templates/page.gacha.liquid`(Vanilla JS、ビルド不要) |
| 通信経路 | Shopify App Proxy |
| バックエンド | Vercel Functions (`api/`, Node.js / TypeScript) |
| データベース | Supabase (PostgreSQL, `sql/`) |
| クーポン発行 | Shopify Admin GraphQL API |

## セットアップ

### 1. Shopify側

1. カスタムアプリを作成し、以下のスコープでAdmin APIアクセストークンを取得する。
   - `write_discounts`, `read_discounts`, `read_products`, `read_orders`, `read_customers`
2. App Proxyを設定する。
   - Subpath prefix: `apps`
   - Subpath: `gacha`
   - Proxy URL: `https://<vercel-app>.vercel.app/api/proxy`
3. 「ガチャチケット」商品(1回券・10回券など)を作成し、バリアントIDを控える。
4. `orders/paid` Webhookを `https://<vercel-app>.vercel.app/api/webhooks/orders-paid` へ登録する。

### 2. Supabase側

`sql/` 配下のファイルを番号順にSQL Editor等で適用する。

```
sql/001_schema.sql        -- テーブル定義
sql/002_draw_function.sql -- draw_gacha(): 抽選本体(1トランザクション)
sql/003_views.sql         -- v_return_rate / v_coupon_use_rate(運用・効果測定ビュー)
sql/004_grant_tickets.sql -- grant_tickets(): チケット付与(Webhook用)
```

適用後、`prizes` と `ticket_products` にデータを投入する。`sql/seed.example.sql` にサンプルがあるので、
実際の `shopify_variant_id` に置き換えて使う。

### 3. Vercel側

`.env.example` を参考に環境変数を設定してデプロイする。

```
SHOPIFY_SHOP_DOMAIN
SHOPIFY_ADMIN_TOKEN
SHOPIFY_API_SECRET       # App Proxy署名検証・Webhook検証に使用
SHOPIFY_API_VERSION      # 省略時 2024-10
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
ADMIN_API_SECRET         # /api/admin/* を叩くための共有シークレット(Bearerトークン)
```

### 4. テーマ側

`theme/templates/page.gacha.liquid` をテーマにアップロードし、管理画面で
このテンプレートを割り当てたページを作成する。テンプレート冒頭の
`ticket_product_url` をチケット商品ページの実URLに書き換えること。

## エンドポイント

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/api/proxy/status` | 残高・今週の回数・景品ラインナップを返す(App Proxy経由) |
| POST | `/api/proxy/draw` | 抽選してクーポンを発行する(App Proxy経由) |
| POST | `/api/webhooks/orders-paid` | チケット付与 + クーポン使用の記録 |
| POST | `/api/admin/reissue` | クーポン未発行のdrawを検出し再発行する(`Authorization: Bearer <ADMIN_API_SECRET>`) |

App Proxy経由のリクエストは `signature` クエリパラメータをタイミングセーフに検証し、
`logged_in_customer_id` が空の場合は401を返す(未ログイン)。リクエストボディから
顧客IDを受け取ることはない。

## 抽選の整合性

- `draw_gacha()`(`sql/002_draw_function.sql`)が `customers` 行をロックしたうえで
  残高チェック・週次カウンタ更新・天井判定・重み付き抽選・残高減算・ログ記録までを
  1トランザクションで行う。
- Shopifyでのクーポン発行(DB外の処理)が失敗しても、抽選成立済みのチケットは
  返却しない(二重消費防止)。`POST /api/proxy/draw` は同じ `idempotency_key` で
  再送されるとクーポン未発行を検出して発行だけを再試行する(自己修復)。
  クライアントが再送してこない場合に備え `POST /api/admin/reissue` で
  クーポン未発行のdrawをバッチ処理できる。

## 運用

- `prizes.weight` をSupabaseのテーブルエディタで編集するだけで確率が変わる(デプロイ不要)。
- `prizes.is_active = false` で景品を停止、`stock_limit` で発行上限を設定できる。
- `v_return_rate` ビューで表示還元率・実質原価率を確認できる(`sql/003_views.sql`)。
- `v_coupon_use_rate` ビューでクーポン使用率(景品別)を確認できる。

## 開発

```bash
npm install
npm run build   # 型チェック
npm test        # 単体テスト(署名検証・週計算)
```

## テストで確認すべき項目(手動含む)

- [ ] 署名なしでAPIを直接叩くと401が返る
- [ ] 未ログイン状態で401が返る
- [ ] 残高0で引こうとすると400が返り、残高が変動しない
- [ ] 同じ `idempotency_key` で2回叩いても抽選は1回しか成立しない
- [ ] ボタン連打で残高が2以上減らない
- [ ] 7回目に必ず `is_guaranteed_pool` の景品が出る
- [ ] 8回目以降は通常抽選に戻る
- [ ] 翌週の月曜にカウンタがリセットされる
- [ ] `stock_limit` に達した景品が抽選対象から外れる
- [ ] 発行されたコードを当選者以外が使えない
- [ ] 同じコードを2回使えない
- [ ] 注文完了後に `coupons.shopify_order_id` が埋まる
- [ ] Webhookを同じイベントIDで2回受けても残高が二重加算されない
- [ ] 重み設定どおりの分布になる(シミュレーションでカイ二乗検定)
