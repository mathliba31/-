export type DiscountType = 'free_product' | 'amount_off' | 'percent_off';

export interface PrizeInfo {
  id: number;
  name: string;
  shopifyVariantId: string;
  discountType: DiscountType;
  discountValue: number;
  listPrice: number;
}

export interface DrawResult {
  drawId: string;
  prize: PrizeInfo;
  isGuaranteed: boolean;
  ticketBalance: number;
  weeklyCount: number;
  weeklyThreshold: number;
  alreadyExisted: boolean;
}

export interface CouponInfo {
  code: string;
  shopifyDiscountId: string | null;
  expiresAt: string;
}
