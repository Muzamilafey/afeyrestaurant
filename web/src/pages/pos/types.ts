export interface Category { _id: string; name: string; icon: string; kind: string; station: string }
export interface ModifierOption { _id: string; name: string; priceDelta: number; active?: boolean }
export interface ModifierGroup { _id: string; name: string; minSelect: number; maxSelect: number; options: ModifierOption[] }
export interface Product {
  _id: string; name: string; description?: string; imageUrl?: string; sku?: string; barcode?: string; plu?: string; price: number; currentPrice: number;
  categoryId: string; dietary: string[]; allergens?: string[]; ageRestricted: boolean; modifierGroupIds: string[]; variants: Array<{ name: string; price: number }>;
  available: boolean; unavailableReason: string | null; servingsLeft: number | null; lowStock: boolean; happyHour: boolean; status: string;
}
export interface Catalog { categories: Category[]; products: Product[]; modifierGroups: ModifierGroup[]; taxes: unknown[]; serverTime: string }
export interface OrderLine {
  lineId: string; productId: string; name: string; station: string; qty: number; unitPrice: number; lineTotal: number; discount: number;
  modifiers: Array<{ groupName?: string; name: string; priceDelta: number }>; notes?: string; status: string; voided: boolean; complimentary?: boolean; variant?: string; ageRestricted?: boolean;
}
export interface Order {
  _id: string; number: string; clientId: string; type: string; outlet?: 'restaurant' | 'bar'; status: string; paymentStatus: string; tableId?: string; tableNumber?: string; guests: number; waiterName?: string;
  customerId?: string; customerName?: string; customerPhone?: string; items: OrderLine[]; notes?: string; receiptNumber?: string; source?: string;
  discount?: { type: string; value: number; amount: number; reason?: string };
  totals: { subtotal: number; discount: number; serviceCharge: number; taxInclusive: number; taxExclusive: number; deliveryFee: number; total: number; paid: number; refunded: number; balance: number };
  taxBreakdown?: Array<{ code: string; rateBps: number; inclusive: boolean; amount: number }>;
  delivery?: { address?: string; status?: string; trackingCode?: string };
}
export interface DraftLine { lineId: string; productId: string; name: string; qty: number; unitPrice: number; variant?: string; modifiers: Array<{ groupId: string; optionId: string; name: string; priceDelta: number }>; notes?: string; ageCheckConfirmed?: boolean; station: string }
