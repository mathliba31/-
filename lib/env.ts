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
  // 以下はアラートメール送信用(任意設定)。未設定ならアラート送信自体をスキップする
  // (lib/alertEmail.ts参照)。必須環境変数として扱わないのは、設定していない
  // 状態でもアプリ本体の動作は妨げないようにするため。
  get smtpHost() {
    return process.env.SMTP_HOST || null;
  },
  get smtpPort() {
    return process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
  },
  get smtpUser() {
    return process.env.SMTP_USER || null;
  },
  get smtpPass() {
    return process.env.SMTP_PASS || null;
  },
  get alertEmailTo() {
    return process.env.ALERT_EMAIL_TO || null;
  },
  get alertEmailFrom() {
    return process.env.ALERT_EMAIL_FROM || process.env.SMTP_USER || null;
  },
};
