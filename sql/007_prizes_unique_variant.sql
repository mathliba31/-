-- Shopifyコレクション+メタフィールドからの同期(upsert)を可能にするための一意制約。
alter table prizes add constraint prizes_shopify_variant_id_key unique (shopify_variant_id);
