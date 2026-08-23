# Shopify ガチャアプリ

Shopifyストア向けの有料ガチャ機能。抽選はサーバー(Vercel Functions)で行い、
抽選エンジンの実データはSupabase(PostgreSQL)に持つ。景品の確率・割引内容などの
設定はShopify商品のメタフィールドで管理し、同期APIでSupabaseへ反映する(運用者は
Shopify管理画面だけを触ればよい)。景品はすべてShopifyの割引コードとして発行し、
決済・在庫・配送はShopifyの通常フローに任せる。

## 構成

| レイヤ | 採用技術 |
|---|---|
| フロントエンド(購入者向け) | `theme/templates/page.gacha.liquid`(Vanilla JS、ビルド不要) |
| フロントエンド(運用者向け) | `api/admin-ui.ts`(Shopify埋め込みアプリ画面。Vanilla JS + App Bridge、ビルド不要) |
| 通信経路 | Shopify App Proxy(購入者向け)/ Shopify App Bridge セッショントークン(運用者向け) |
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
6. `shopify.app.toml` を以下のように設定し、埋め込みのイベント設定画面を有効化する(詳細は
   「イベント設定画面(埋め込みアプリ)」参照)。
   ```toml
   embedded = true
   application_url = "https://<vercel-app>.vercel.app/api/admin-ui"
   ```

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
sql/008_event_pity.sql    -- 天井判定を週次からイベント期間ベースに変更(draw_gacha()を更新)
```

適用後、`ticket_products`(チケット商品の対応表)にデータを投入する。`prizes`(景品マスタ)は
「景品の管理」に記載の同期API経由で投入するため、手動での初期投入は不要。

### 3. Vercel側

`.env.example` を参考に環境変数を設定してデプロイする。

```
SHOPIFY_SHOP_DOMAIN
SHOPIFY_ADMIN_TOKEN
SHOPIFY_API_SECRET       # App Proxy署名検証・Webhook検証・セッショントークン検証に使用
SHOPIFY_CLIENT_ID        # 埋め込み管理画面(api/admin-ui.ts)のApp Bridge初期化・セッショントークン検証(aud)用
SHOPIFY_API_VERSION      # 省略時 2024-10
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
ADMIN_API_SECRET         # /api/admin/reissue, /api/admin/sync-prizes を叩くための共有シークレット(Bearerトークン)
SHOPIFY_GACHA_COLLECTION_HANDLE  # 「ガチャ景品」コレクションのハンドル(景品同期に使用)
```

### 4. テーマ側

`theme/templates/page.gacha.liquid` をテーマにアップロードし、管理画面で
このテンプレートを割り当てたページを作成する。テンプレート冒頭の
`ticket_product_url` をチケット商品ページの実URLに書き換えること。

## エンドポイント

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/api/proxy/status` | 残高・開催中イベントの天井進捗・景品ラインナップを返す(App Proxy経由) |
| POST | `/api/proxy/draw` | 抽選してクーポンを発行する(App Proxy経由) |
| POST | `/api/webhooks/orders-paid` | チケット付与 + クーポン使用の記録 |
| POST | `/api/webhooks/customers-data-request` | GDPR必須Webhook: 顧客データ開示要求の受付ログ |
| POST | `/api/webhooks/customers-redact` | GDPR必須Webhook: 顧客データ削除要求(個人情報は保存していないため受領確認のみ) |
| POST | `/api/webhooks/shop-redact` | GDPR必須Webhook: アプリアンインストール後48時間で顧客関連データを削除 |
| POST | `/api/admin/reissue` | クーポン未発行のdrawを検出し再発行する(`Authorization: Bearer <ADMIN_API_SECRET>`) |
| POST | `/api/admin/sync-prizes` | Shopifyの「ガチャ景品」コレクション+メタフィールドを`prizes`へ同期する(`Authorization: Bearer <ADMIN_API_SECRET>`) |
| GET / POST | `/api/admin/events` | `campaign_events`の一覧取得・作成(App Bridgeセッショントークンで認証) |
| GET | `/api/admin-ui` | Shopify埋め込みのイベント設定画面(HTML) |
| PATCH / DELETE | `/api/admin/events/:id` | `campaign_events`の更新・削除(App Bridgeセッショントークンで認証) |

App Proxy経由のリクエストは `signature` クエリパラメータをタイミングセーフに検証し、
`logged_in_customer_id` が空の場合は401を返す(未ログイン)。リクエストボディから
顧客IDを受け取ることはない。`/api/admin/events*` はApp Proxyではなく、埋め込み管理画面
(`/api/admin-ui`)からApp Bridgeのセッショントークンを使って呼ばれる(詳細は次項)。

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

### 天井(確定枠抽選)の期間限定について

天井の「いつ・何回で発動するか」と「発動したら何が対象になるか」は別々の仕組みになっている。

- **いつ・何回で発動するか**: `campaign_events`(後述「Shopify Flowでのセグメント配信」参照)で
  自動制御される。**有効なイベントが1件も無い間は天井そのものが発生しない**。イベント期間中のみ、
  そのイベントの`pity_threshold`(未設定なら`settings.pity_threshold`)回引くごとに天井が発動する。
  日付はイベントの`starts_at`/`ends_at`で管理するため、`POST /api/admin/sync-prizes`の実行は不要
  (`campaign_events`テーブルへのSQL操作のみで完結する)。
- **発動したら何が対象になるか**: 天井発動時に抽選対象となる景品は`is_guaranteed_pool = true`の
  商品群。こちらは商品に対する固定フラグで、日付の自動切り替えには対応していない。
  「このイベント期間だけこの景品を天井対象にしたい」場合は、以下を手動で行う。

  1. イベント開始前に、対象商品の `gacha.is_guaranteed_pool` をShopify管理画面で `true` にする
  2. `POST /api/admin/sync-prizes` を実行して反映する
  3. イベント終了後に `false` に戻し、再度 `POST /api/admin/sync-prizes` を実行する

  切り替え忘れに注意。頻繁に景品側も入れ替える場合は、`gacha.guaranteed_pool_starts_at`/
  `gacha.guaranteed_pool_ends_at`(日付型)メタフィールドを追加して同期時に判定する拡張も
  可能(未実装)。

## 抽選の整合性

- `draw_gacha()`(`sql/002_draw_function.sql` → `sql/008_event_pity.sql`で更新)が
  `customers` 行をロックしたうえで残高チェック・天井判定(イベント期間中の`draws`集計)・
  重み付き抽選・残高減算・ログ記録までを1トランザクションで行う。`customers`行のロックにより
  同一顧客の並行リクエストは直列化されるため、天井判定用の専用カウンタテーブルは使わず
  `draws`テーブルを直接集計している。
- Shopifyでのクーポン発行(DB外の処理)が失敗しても、抽選成立済みのチケットは
  返却しない(二重消費防止)。`POST /api/proxy/draw` は同じ `idempotency_key` で
  再送されるとクーポン未発行を検出して発行だけを再試行する(自己修復)。
  クライアントが再送してこない場合に備え `POST /api/admin/reissue` で
  クーポン未発行のdrawをバッチ処理できる。

## イベント設定画面(埋め込みアプリ)

`campaign_events`(イベント期間・天井N回数)はSQLを直接書かなくても、Shopify管理画面に
埋め込まれた設定画面から作成・編集・削除・有効/無効切り替えができる。

### 仕組み

- `api/admin-ui.ts` が埋め込みページのHTMLを返す。ビルドツールは使わず、Shopifyの
  App Bridge(CDN配信の`app-bridge.js`)+ Vanilla JSのみで構成している(購入者向けの
  `page.gacha.liquid`と同じ方針)。
- 画面上の操作は `GET/POST /api/admin/events`・`PATCH/DELETE /api/admin/events/:id` を叩く。
  認証はApp Bridgeが自動的に発行するセッショントークン(JWT)を`Authorization: Bearer`で送り、
  `lib/shopifySessionAuth.ts`がShopify API SecretでHS256署名を検証する
  (`aud`がClient ID、`dest`がストアドメインと一致するかも確認する)。
  `/api/admin/reissue`・`/api/admin/sync-prizes`が使う`ADMIN_API_SECRET`共有シークレット方式とは
  別の認証経路であり、ブラウザから直接叩かれるこの画面専用になっている。

### 有効化手順

1. Shopify Dev Dashboardで対象アプリの `shopify.app.toml` を以下のように設定する。
   ```toml
   embedded = true
   application_url = "https://<vercel-app>.vercel.app/api/admin-ui"
   ```
2. `shopify app deploy` で反映する。
3. Shopify管理画面の「アプリ」からこのアプリを開くと、埋め込みのイベント設定画面が表示される。

### 画面でできること

- イベントの新規作成(キー・表示名・開始日時・終了日時・天井N回数・有効フラグ)
- 既存イベントの編集・有効/無効の切り替え・削除
- 一覧で「開催中」のイベントをひと目で確認(now が starts_at〜ends_atの範囲内かで判定)

デプロイ不要でSupabaseへ即時反映される点はSQL直接編集の場合と同じ。

## イベント期間管理(`campaign_events`)

`campaign_events`テーブルは2つの用途を兼ねている。

1. **天井(確定枠抽選)の自動制御**: `draw_gacha()`が「現在有効なイベント」の期間中の
   抽選回数を数え、`pity_threshold`回に達するとその回を天井にする。有効なイベントが
   無い間は天井が発生しない(「景品の管理」の「天井(確定枠抽選)の期間限定について」参照)。
2. **Shopify Flowでのセグメント配信**: 抽選が成立するたびに、以下の顧客メタフィールド
   (namespace: `gacha`)を更新する(`lib/syncGachaMetafields.ts` → `api/proxy/draw.ts`)。
   抽選結果・クーポン発行そのものには影響しないfail-safeな副次処理として実装しており、
   書き込みに失敗してもAPIレスポンスは正常に返る。

| キー | 型 | 内容 |
|---|---|---|
| `gacha.lifetime_draw_count` | number_integer | 全期間の累計抽選回数 |
| `gacha.current_event_key` | single_line_text_field | 現在有効なイベントの`key`(無ければ`"none"`。Shopifyは空文字の書き込みを許可しないため) |
| `gacha.current_event_draw_count` | number_integer | 現在有効なイベント期間中の抽選回数(イベントが無ければ0) |

### 事前準備

1. Shopify管理画面の「設定 → カスタムデータ → 顧客」で、上表と同じ namespace/key/型のメタフィールド定義を作成する
   (Flow・セグメントのピッカーに表示するために必須)。
2. カスタムアプリのスコープに `write_customers` を追加する(上記参照)。

### イベント期間の運用

「イベント設定画面(埋め込みアプリ)」の画面から行うのが基本(前項参照)。SQLで直接
操作したい場合は `campaign_events` テーブルに行を追加するだけでもよい(デプロイ不要)。
`pity_threshold` に「イベント期間中N回引くと天井」の**N**を指定する(省略・NULLなら
`settings.pity_threshold` がフォールバックとして使われる)。

```sql
insert into campaign_events (key, name, starts_at, ends_at, pity_threshold) values
  ('summer_2026', 'サマーガチャ2026', '2026-08-01T00:00:00+09', '2026-08-31T23:59:59+09', 10);
```

- 複数のイベントが期間的に重複している場合は `starts_at` が新しいものが優先される。
- 期間内でも `is_active = false` にすれば手動で無効化できる(天井も即座に停止する)。
- イベント終了後(`ends_at` を過ぎる)は、天井が発生しなくなり、
  `current_event_key` / `current_event_draw_count` も自動的に`"none"`/0に戻る。
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
- 天井(確定枠抽選)のON/OFFと回数(N)は、Shopify管理画面の埋め込み設定画面から変えられる
  (デプロイ不要。「イベント設定画面(埋め込みアプリ)」参照)。有効なイベントが無い間は天井は発生しない。
- `v_return_rate` ビューで表示還元率・実質原価率を確認できる(`sql/003_views.sql`)。
- `v_coupon_use_rate` ビューでクーポン使用率(景品別)を確認できる。

## 開発

```bash
npm install
npm run typecheck  # 型チェック
npm test        # 単体テスト(署名検証)
```

## テストで確認すべき項目(手動含む)

- [ ] 署名なしでAPIを直接叩くと401が返る
- [ ] 未ログイン状態で401が返る
- [ ] 残高0で引こうとすると400が返り、残高が変動しない
- [ ] 同じ `idempotency_key` で2回叩いても抽選は1回しか成立しない
- [ ] ボタン連打で残高が2以上減らない
- [ ] 有効なイベントが無い間は天井が一切発生しない
- [ ] イベント期間中、`pity_threshold`回目に必ず `is_guaranteed_pool` の景品が出る
- [ ] 同一イベント内でその後(N+1回目以降)は通常抽選に戻る
- [ ] イベントを`is_active = false`にすると即座に天井が停止する
- [ ] `stock_limit` に達した景品が抽選対象から外れる
- [ ] 発行されたコードを当選者以外が使えない
- [ ] 同じコードを2回使えない
- [ ] 注文完了後に `coupons.shopify_order_id` が埋まる
- [ ] Webhookを同じイベントIDで2回受けても残高が二重加算されない
- [ ] 重み設定どおりの分布になる(シミュレーションでカイ二乗検定)
