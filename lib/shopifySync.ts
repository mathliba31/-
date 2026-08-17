import { shopifyGraphQL, type GraphQLResponse } from './shopifyAdmin';
import type { DiscountType } from './types';

const GACHA_COLLECTION_QUERY = /* GraphQL */ `
  query GachaCollectionProducts($handle: String!, $cursor: String) {
    collectionByHandle(handle: $handle) {
      id
      products(first: 50, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          title
          variants(first: 1) {
            nodes {
              id
              price
            }
          }
          weight: metafield(namespace: "gacha", key: "weight") {
            value
          }
          discountType: metafield(namespace: "gacha", key: "discount_type") {
            value
          }
          discountValue: metafield(namespace: "gacha", key: "discount_value") {
            value
          }
          isGuaranteedPool: metafield(namespace: "gacha", key: "is_guaranteed_pool") {
            value
          }
          stockLimit: metafield(namespace: "gacha", key: "stock_limit") {
            value
          }
          unitCost: metafield(namespace: "gacha", key: "unit_cost") {
            value
          }
        }
      }
    }
  }
`;

interface ProductNode {
  id: string;
  title: string;
  variants: { nodes: Array<{ id: string; price: string }> };
  weight: { value: string } | null;
  discountType: { value: string } | null;
  discountValue: { value: string } | null;
  isGuaranteedPool: { value: string } | null;
  stockLimit: { value: string } | null;
  unitCost: { value: string } | null;
}

interface CollectionQueryResult {
  collectionByHandle: {
    products: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: ProductNode[];
    };
  } | null;
}

export interface SyncedPrize {
  variantId: string;
  name: string;
  listPrice: number;
  weight: number;
  discountType: DiscountType;
  discountValue: number;
  isGuaranteedPool: boolean;
  stockLimit: number | null;
  unitCost: number;
}

export interface SkippedProduct {
  productId: string;
  title: string;
  reason: string;
}

const VALID_DISCOUNT_TYPES: DiscountType[] = ['free_product', 'amount_off', 'percent_off'];

function gidToId(gid: string): string {
  return gid.split('/').pop() ?? gid;
}

/**
 * 「ガチャ景品」コレクション内の商品を、gachaメタフィールド(weight/discount_type/
 * discount_value/is_guaranteed_pool/stock_limit/unit_cost)とともに取得する。
 * weightメタフィールドが未設定の商品は「まだ設定が完了していない景品」として除外する。
 * 複数バリアントを持つ商品は先頭のバリアントのみを対象にする。
 */
export async function fetchGachaCollectionProducts(
  collectionHandle: string,
): Promise<{ prizes: SyncedPrize[]; skipped: SkippedProduct[] }> {
  const prizes: SyncedPrize[] = [];
  const skipped: SkippedProduct[] = [];

  let cursor: string | null = null;
  let hasNextPage = true;
  let sawCollection = false;

  while (hasNextPage) {
    const result: GraphQLResponse<CollectionQueryResult> = await shopifyGraphQL<CollectionQueryResult>(
      GACHA_COLLECTION_QUERY,
      { handle: collectionHandle, cursor },
    );

    if (result.errors?.length) {
      throw new Error(`Shopify GraphQLエラー: ${result.errors.map((e: { message: string }) => e.message).join(', ')}`);
    }

    const collection = result.data?.collectionByHandle;
    if (!collection) {
      if (!sawCollection) {
        throw new Error(`コレクション "${collectionHandle}" が見つかりません`);
      }
      break;
    }
    sawCollection = true;

    for (const product of collection.products.nodes) {
      const variant = product.variants.nodes[0];
      if (!variant) {
        skipped.push({ productId: gidToId(product.id), title: product.title, reason: 'バリアントが無い' });
        continue;
      }

      const weight = Number(product.weight?.value);
      if (!Number.isFinite(weight) || weight < 0) {
        skipped.push({
          productId: gidToId(product.id),
          title: product.title,
          reason: 'gacha.weight メタフィールドが未設定または不正',
        });
        continue;
      }

      const discountType = (product.discountType?.value || 'free_product') as DiscountType;
      if (!VALID_DISCOUNT_TYPES.includes(discountType)) {
        skipped.push({
          productId: gidToId(product.id),
          title: product.title,
          reason: `gacha.discount_type の値が不正: ${product.discountType?.value}`,
        });
        continue;
      }

      prizes.push({
        variantId: gidToId(variant.id),
        name: product.title,
        listPrice: Math.round(Number(variant.price) || 0),
        weight,
        discountType,
        discountValue: Number(product.discountValue?.value) || 0,
        isGuaranteedPool: product.isGuaranteedPool?.value === 'true',
        stockLimit: product.stockLimit?.value ? Number(product.stockLimit.value) : null,
        unitCost: Number(product.unitCost?.value) || 0,
      });
    }

    hasNextPage = collection.products.pageInfo.hasNextPage;
    cursor = collection.products.pageInfo.endCursor;
  }

  return { prizes, skipped };
}
