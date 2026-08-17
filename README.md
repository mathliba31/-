# Shopify ガチャアプリ

Shopifyストア向けの有料ガチャ機能。抽選はサーバー(Vercel Functions)で行い、
抽選エンジンの実データはSupabase(PostgreSQL)に持つ。景品の確率・割引内容などの
設定はShopify商品のメタフィールドで管理し、同期APIでSupabaseへ反映する(運用者は
Shopify管理画面だけを触ればよい)。景品はすべてShopifyの割引コードとして発行し、
決済・在庫・配送はShopifyの通常フローに任せる。

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
   - `write_discounts`, `read_discounts`, `read_products`, `read_orders`, `read_customers`, `write_customers`(顧客メタフィールド書き込み用)
2. App Proxyを設定する。
   - Subpath prefix: `apps`
   - Subpath: `gacha`
   - Proxy URL: `https://<vercel-app>.vercel.app/api/proxy`
3. 「ガチャチケット」商品(1回券・10回券など)を作成し、バリアントIDを控える。
4. `orders/paid` Webhookを `https://<vercel-app>.vercel.app/api/webhooks/orders-paid` へ登録する。
5. 景品管理用に、商品メタフィールド定義とコレクションを用意する(詳細は「景品の管理」参照)。

### 2. Supabase側

`sql/` 配下のファイルを番号順にSQL Editor等で適用する。

```
sql/001_schema.sql        -- テーブル定義
sql/002_draw_function.sql -- draw_gacha(): 抽選本体(1トランザクション)
sql/003_views.sql         -- v_return_rate / v_coupon_use_rate(運用・効果測定ビュー)
sql/004_grant_tickets.sql -- grant_tickets(): チケット付与(Webhook用)
sql/005_enable_rls.sql    -- 全テーブルでRLSを有効化(anon/authenticatedからのアクセスを遮断)
sql/006_campaign_events.sql -- campaign_events: Flowセグメント配信用のイベント期間管理
sql/007_prizes_unique_variant.sql -- prizesにshopify_variant_idの一意制約を追加(景品同期のupsert用)
```

適用後、`ticket_products`(チケット商品の対応表)にデータを投入する。`prizes`(景品マスタ)は
「景品の管理」に記載の同期API経由で投入するため、手動での初期投入は不要。

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
SHOPIFY_GACHA_COLLECTION_HANDLE  # 「ガチャ景品」コレクションのハンドル(景品同期に使用)
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
| POST | `/api/webhooks/customers-data-request` | GDPR必須Webhook: 顧客データ開示要求の受付ログ |
| POST | `/api/webhooks/customers-redact` | GDPR必須Webhook: 顧客データ削除要求(個人情報は保存していないため受領確認のみ) |
| POST | `/api/webhooks/shop-redact` | GDPR必須Webhook: アプリアンインストール後48時間で顧客関連データを削除 |
| POST | `/api/admin/reissue` | クーポン未発行のdrawを検出し再発行する(`Authorization: Bearer <ADMIN_API_SECRET>`) |
| POST | `/api/admin/sync-prizes` | Shopifyの「ガチャ景品」コレクション+メタフィールドを`prizes`へ同期する(`Authorization: Bearer <ADMIN_API_SECRET>`) |

App Proxy経由のリクエストは `signature` クエリパラメータをタイミングセーフに検証し、
`logged_in_customer_id` が空の場合は401を返す(未ログイン)。リクエストボディから
顧客IDを受け取ることはない。

### GDPR必須Webhookについて

`orders/paid` のように顧客の個人情報(氏名・住所等)を含みうるWebhookトピックを購読するには、
Shopify Dev Dashboardで「Protected customer data access」の申請が必要。この申請では
`customers/data_request` / `customers/redact` / `shop/redact` の3つの必須コンプライアンスWebhookを
実装済みであることが前提となるため、`shopify.app.toml` の `[[webhooks.subscriptions]]` に
以下も追加しておくこと。

```toml
[[webhooks.subscriptions]]
topics = ["customers/data_request"]
uri = "https://<VercelのURL>/api/webhooks/customers-data-request"

[[webhooks.subscriptions]]
topics = ["customers/redact"]
uri = "https://<VercelのURL>/api/webhooks/customers-redact"

[[webhooks.subscriptions]]
topics = ["shop/redact"]
uri = "https://<VercelのURL>/api/webhooks/shop-redact"
```

当アプリは氏名・メール・住所等の個人情報を一切保存しない設計(保持するのはShopify顧客IDに
紐づくチケット残高・抽選履歴・クーポンのみ)のため、`customers/redact` は受領確認のみ返す。
`shop/redact` はアンインストール48時間後に顧客関連データ(`customers`/`ticket_ledger`/
`weekly_counters`/`draws`/`coupons`)を削除する(景品マスタ等の運用設定は残す)。

## 景品の管理(Shopify商品メタフィールド + コレクション同期)

景品の確率や割引内容は、SupabaseのテーブルではなくShopify商品側で管理する。
運用者はShopify管理画面(商品編集・コレクション編集)だけを触ればよい。

### 仕組み

1. 「ガチャ景品」コレクション(ハンドルは`SHOPIFY_GACHA_COLLECTION_HANDLE`で指定)を作成し、
   景品にしたい商品を追加する。
2. 各商品に、以下の商品メタフィールド(namespace: `gacha`)を設定する。
3. `POST /api/admin/sync-prizes` を叩くと、コレクション内の商品とメタフィールドを読み取り、
   Supabaseの`prizes`テーブルへ upsert する(`lib/shopifySync.ts` → `api/admin/sync-prizes.ts`)。
   コレクションから外れた商品は`is_active = false`になる(過去ログとの整合性のため削除はしない)。

### メタフィールド定義(Settings → カスタムデータ → 商品 で作成)

| キー | 型 | 内容 |
|---|---|---|
| `gacha.weight` | number_integer | 抽選の重み。**未設定の商品は同期対象外**(コレクションに入れただけでは有効にならない) |
| `gacha.discount_type` | single_line_text_field | `free_product` / `amount_off` / `percent_off`。未設定時は`free_product` |
| `gacha.discount_value` | number_integer | `amount_off`は円、`percent_off`は% |
| `gacha.is_guaranteed_pool` | boolean | 天井(確定枠)の対象かどうか |
| `gacha.stock_limit` | number_integer | ガチャとしての発行上限(Shopifyの在庫数とは別概念)。未設定なら無制限 |
| `gacha.unit_cost` | number_integer | 実質原価(保管コスト+廃棄リスク−回収額)。還元率レポート用 |

商品の**定価**(`list_price`)と**商品名**はメタフィールドではなく、商品の価格・タイトルからそのまま読み取る。
複数バリアントを持つ商品は先頭のバリアントのみが対象になる。

### 同期の実行

```bash
curl -X POST https://<VercelのURL>/api/admin/sync-prizes \
  -H "Authorization: Bearer <ADMIN_API_SECRET>"
```

レスポンスに`upserted`(反映件数)・`deactivated`(無効化件数)・`skipped`(メタフィールド未設定などでスキップした商品と理由)・`failures`が返る。
商品を追加・変更したら、この同期を実行するだけで反映される(デプロイ不要)。

### 天井(`is_guaranteed_pool`)を期間限定にしたい場合(手動運用)

`is_guaranteed_pool`は商品に対する固定フラグで、日付の自動切り替えには対応していない。
「10/10〜10/20だけ天井対象にする」のような期間限定運用は、以下の手順で手動で行う。

1. 開始日に、対象商品の `gacha.is_guaranteed_pool` をShopify管理画面で `true` にする
2. `POST /api/admin/sync-prizes` を実行して反映する
3. 終了日に `false` に戻し、再度 `POST /api/admin/sync-prizes` を実行する

切り替え忘れに注意。頻繁に期間限定運用を行う場合は、`gacha.guaranteed_pool_starts_at`/
`gacha.guaranteed_pool_ends_at`(日付型)メタフィールドを追加して`draw_gacha()`側で
自動判定する拡張も可能(未実装)。

## 抽選の整合性

- `draw_gacha()`(`sql/002_draw_function.sql`)が `customers` 行をロックしたうえで
  残高チェック・週次カウンタ更新・天井判定・重み付き抽選・残高減算・ログ記録までを
  1トランザクションで行う。
- Shopifyでのクーポン発行(DB外の処理)が失敗しても、抽選成立済みのチケットは
  返却しない(二重消費防止)。`POST /api/proxy/draw` は同じ `idempotency_key` で
  再送されるとクーポン未発行を検出して発行だけを再試行する(自己修復)。
  クライアントが再送してこない場合に備え `POST /api/admin/reissue` で
  クーポン未発行のdrawをバッチ処理できる。

## Shopify Flowでのセグメント配信(顧客メタフィールド)

抽選が成立するたびに、以下の顧客メタフィールド(namespace: `gacha`)を更新する
(`lib/syncGachaMetafields.ts` → `api/proxy/draw.ts`)。抽選結果・クーポン発行そのものには
影響しないfail-safeな副次処理として実装しており、書き込みに失敗してもAPIレスポンスは正常に返る。

| キー | 型 | 内容 |
|---|---|---|
| `gacha.lifetime_draw_count` | number_integer | 全期間の累計抽選回数 |
| `gacha.current_event_key` | single_line_text_field | 現在有効なイベントの`key`(無ければ空文字) |
| `gacha.current_event_draw_count` | number_integer | 現在有効なイベント期間中の抽選回数(イベントが無ければ0) |

### 事前準備

1. Shopify管理画面の「設定 → カスタムデータ → 顧客」で、上表と同じ namespace/key/型のメタフィールド定義を作成する
   (Flow・セグメントのピッカーに表示するために必須)。
2. カスタムアプリのスコープに `write_customers` を追加する(上記参照)。

### イベント期間の運用

`campaign_events` テーブルに行を追加するだけでイベントを開始・終了できる(デプロイ不要)。

```sql
insert into campaign_events (key, name, starts_at, ends_at) values
  ('summer_2026', 'サマーガチャ2026', '2026-08-01T00:00:00+09', '2026-08-31T23:59:59+09');
```

- 複数のイベントが期間的に重複している場合は `starts_at` が新しいものが優先される。
- 期間内でも `is_active = false` にすれば手動で無効化できる。
- イベント終了後(`ends_at` を過ぎる)は `current_event_key` / `current_event_draw_count` が自動的に空/0に戻る。
  過去イベントの実績を保持したい場合は、`draws.created_at` と当時の `starts_at`/`ends_at` から
  いつでも再集計できるので、終了時にSQLで別途集計・エクスポートすること。

### Flow側の設定例

- トリガー: 「顧客メタフィールドが更新された」(`gacha.current_event_draw_count`)
- 条件: `current_event_key` が対象イベントの`key`と一致 かつ `current_event_draw_count` が◯回以上
- アクション: セグメントへのタグ付け・メール配信など

## 運用

- 景品の確率(`weight`)や割引内容は、Shopify商品のメタフィールドを編集して
  `POST /api/admin/sync-prizes` を叩くだけで変わる(デプロイ不要。「景品の管理」参照)。
- 景品を止めたいときはコレクションから外す(`is_active = false`になる)、
  上限を設けたいときは`gacha.stock_limit`メタフィールドを設定する。
- `v_return_rate` ビューで表示還元率・実質原価率を確認できる(`sql/003_views.sql`)。
- `v_coupon_use_rate` ビューでクーポン使用率(景品別)を確認できる。

## 開発

```bash
npm install
npm run typecheck  # 型チェック
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
