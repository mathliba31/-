import { env } from './env';
import { generateCouponCode } from './couponCode';
import type { PrizeInfo } from './types';

const DISCOUNT_CREATE_MUTATION = /* GraphQL */ `
  mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode {
        id
        codeDiscount {
          ... on DiscountCodeBasic {
            codes(first: 1) {
              nodes {
                code
              }
            }
          }
        }
      }
      userErrors {
        field
        code
        message
      }
    }
  }
`;

export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export async function shopifyGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<GraphQLResponse<T>> {
  const url = `https://${env.shopifyShopDomain}/admin/api/${env.shopifyApiVersion}/graphql.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': env.shopifyAdminToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify Admin API error: ${res.status} ${text}`);
  }

  return (await res.json()) as GraphQLResponse<T>;
}

function customerGID(shopifyCustomerId: string): string {
  return `gid://shopify/Customer/${shopifyCustomerId}`;
}

const METAFIELDS_SET_MUTATION = /* GraphQL */ `
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
      }
      userErrors {
        field
        code
        message
      }
    }
  }
`;

interface MetafieldsSetPayload {
  metafieldsSet: {
    metafields: Array<{ id: string; namespace: string; key: string }>;
    userErrors: Array<{ field: string[]; code: string; message: string }>;
  };
}

export interface CustomerMetafieldInput {
  namespace: string;
  key: string;
  type: string;
  value: string;
}

/**
 * 顧客メタフィールドをまとめて書き込む(Shopify Flowでのセグメント配信用)。
 * 書き込み先には Settings > Custom data > Customers で同じ namespace/key の
 * メタフィールド定義を事前に作成しておく必要がある(Flow/Segmentのピッカーに出すため)。
 * 要 write_customers スコープ。
 */
export async function setCustomerMetafields(params: {
  shopifyCustomerId: string;
  metafields: CustomerMetafieldInput[];
}): Promise<void> {
  const { shopifyCustomerId, metafields } = params;
  if (metafields.length === 0) return;

  const variables = {
    metafields: metafields.map((m) => ({
      ownerId: customerGID(shopifyCustomerId),
      namespace: m.namespace,
      key: m.key,
      type: m.type,
      value: m.value,
    })),
  };

  const result = await shopifyGraphQL<MetafieldsSetPayload>(METAFIELDS_SET_MUTATION, variables);

  if (result.errors?.length) {
    throw new Error(`Shopify GraphQLエラー: ${result.errors.map((e) => e.message).join(', ')}`);
  }

  const userErrors = result.data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(`メタフィールド書き込みに失敗しました: ${userErrors.map((e) => e.message).join(', ')}`);
  }
}

function variantGID(shopifyVariantId: string): string {
  return `gid://shopify/ProductVariant/${shopifyVariantId}`;
}

function buildCustomerGets(prize: PrizeInfo) {
  const items = {
    products: {
      productVariantsToAdd: [variantGID(prize.shopifyVariantId)],
    },
  };

  switch (prize.discountType) {
    case 'free_product':
      return { value: { percentage: 1.0 }, items };
    case 'percent_off':
      return { value: { percentage: prize.discountValue / 100 }, items };
    case 'amount_off':
      return {
        value: {
          discountAmount: {
            // Decimal scalar は文字列で渡す
            amount: String(prize.discountValue),
            appliesOnEachItem: false,
          },
        },
        items,
      };
    default:
      throw new Error(`未知の discount_type: ${prize.discountType satisfies never}`);
  }
}

interface DiscountCodeBasicCreatePayload {
  discountCodeBasicCreate: {
    codeDiscountNode: {
      id: string;
      codeDiscount: { codes: { nodes: Array<{ code: string }> } };
    } | null;
    userErrors: Array<{ field: string[]; code: string; message: string }>;
  };
}

export interface CreateDiscountResult {
  code: string;
  shopifyDiscountId: string;
}

/**
 * 当選者専用の割引コードを発行する。
 * - usageLimit: 1, appliesOncePerCustomer: true で使い回しを防ぐ
 * - customerSelection を当選者のみに限定し、他人にコードを渡せないようにする
 * - コード衝突時は最大3回リトライする
 */
export async function createDiscountCodeForPrize(params: {
  prize: PrizeInfo;
  shopifyCustomerId: string;
  expiresAt: Date;
}): Promise<CreateDiscountResult> {
  const { prize, shopifyCustomerId, expiresAt } = params;

  let lastErrorMessage = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateCouponCode();

    const variables = {
      basicCodeDiscount: {
        title: code,
        code,
        startsAt: new Date().toISOString(),
        endsAt: expiresAt.toISOString(),
        usageLimit: 1,
        appliesOncePerCustomer: true,
        customerSelection: {
          customers: { add: [customerGID(shopifyCustomerId)] },
        },
        customerGets: buildCustomerGets(prize),
      },
    };

    const result = await shopifyGraphQL<DiscountCodeBasicCreatePayload>(DISCOUNT_CREATE_MUTATION, variables);

    if (result.errors?.length) {
      throw new Error(`Shopify GraphQLエラー: ${result.errors.map((e) => e.message).join(', ')}`);
    }

    const payload = result.data?.discountCodeBasicCreate;
    const userErrors = payload?.userErrors ?? [];

    if (userErrors.length === 0 && payload?.codeDiscountNode) {
      const issuedCode = payload.codeDiscountNode.codeDiscount.codes.nodes[0]?.code ?? code;
      return { code: issuedCode, shopifyDiscountId: payload.codeDiscountNode.id };
    }

    const isCodeTaken = userErrors.some((e) => e.code === 'CODE_TAKEN' || /already exists|taken/i.test(e.message));
    lastErrorMessage = userErrors.map((e) => e.message).join(', ') || 'unknown error';
    if (!isCodeTaken) {
      throw new Error(`割引コード発行に失敗しました: ${lastErrorMessage}`);
    }
    // コード衝突時はループ継続してリトライ
  }

  throw new Error(`割引コード発行に失敗しました(コード衝突が3回連続): ${lastErrorMessage}`);
}
