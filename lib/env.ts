function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`環境変数 ${name} が設定されていません`);
  }
  return value;
}

export const env = {
  get shopifyShopDomain() {
    return required('SHOPIFY_SHOP_DOMAIN');
  },
  get shopifyAdminToken() {
    return required('SHOPIFY_ADMIN_TOKEN');
  },
  get shopifyApiSecret() {
    return required('SHOPIFY_API_SECRET');
  },
  get shopifyClientId() {
    return required('SHOPIFY_CLIENT_ID');
  },
  get shopifyApiVersion() {
    return process.env.SHOPIFY_API_VERSION || '2024-10';
  },
  get shopifyCurrencyCode() {
    return process.env.SHOPIFY_CURRENCY_CODE || 'JPY';
  },
  get shopifyGachaCollectionHandle() {
    return required('SHOPIFY_GACHA_COLLECTION_HANDLE');
  },
  get supabaseUrl() {
    return required('SUPABASE_URL');
  },
  get supabaseServiceRoleKey() {
    return required('SUPABASE_SERVICE_ROLE_KEY');
  },
  get adminApiSecret() {
    return required('ADMIN_API_SECRET');
  },
};
