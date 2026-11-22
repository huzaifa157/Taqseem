import Decimal from "decimal.js";

import {
  calculateLineAmounts,
  type DiscountTier,
  type DiscountType,
  resolveDiscount,
} from "./pricing";
import { PACKETS_PER_DOZEN } from "./units";

// Sales order rules shared by the server (what is stored) and the order-entry screen (what the user
// sees while typing), so both always agree. Pure: no database, no Prisma.

type DecimalValue = Decimal | number | string;
const D = (v: DecimalValue) => new Decimal(v);
const ZERO = new Decimal(0);

export type PricedProduct = {
  id: string;
  companyId: string;
  saleRate: DecimalValue;
  discountType: DiscountType;
  discountValue: DecimalValue;
  tiers: DiscountTier[];
};

export type PricedLine = {
  productId: string;
  companyId: string;
  /** Half dozens. */
  quantity: number;
  rate: Decimal;
  discountType: DiscountType;
  discountValue: Decimal;
  grossAmount: Decimal;
  discountAmount: Decimal;
  taxAmount: Decimal;
  netAmount: Decimal;
  /** The customer's own discount was used (in place of the product's discount and slabs). */
  customerDiscount?: boolean;
};

/**
 * A customer's discount as typed: Rs per dozen, from 0 up to the rate. Blank = none (the product's
 * own discount and slabs apply). Returns null for blank, or an error message.
 */
export function readCustomerDiscount(
  value: string | null | undefined,
  saleRate: DecimalValue,
): { discount: Decimal | null; error?: string } {
  const text = (value ?? "").trim().replace(/,/g, "");
  if (text === "") return { discount: null };
  if (!/^\d+(\.\d{1,2})?$/.test(text))
    return { discount: null, error: "Discount: a number of rupees per dozen, e.g. 25" };
  const discount = D(text);
  if (discount.gt(D(saleRate)))
    return { discount: null, error: "Discount: cannot be more than the rate" };
  return { discount };
}

/**
 * Prices a line for a customer. Rates are fixed (the product's sale rate); a customer's own
 * discount per dozen, when there is one, is used in place of the product's discount and slabs.
 * Without one, the line is priced normally.
 */
export function priceLineFor(
  product: PricedProduct,
  quantity: number,
  customerDiscount: DecimalValue | null | undefined,
): PricedLine {
  if (customerDiscount === null || customerDiscount === undefined || customerDiscount === "")
    return priceLine(product, quantity);
  const amounts = calculateLineAmounts({
    quantity,
    baseUnitsPerPriceUnit: PACKETS_PER_DOZEN,
    rate: product.saleRate,
    discountType: "AMOUNT_PER_UNIT",
    discountValue: customerDiscount,
  });
  return {
    productId: product.id,
    companyId: product.companyId,
    quantity,
    rate: D(product.saleRate),
    discountType: "AMOUNT_PER_UNIT",
    discountValue: D(customerDiscount),
    ...amounts,
    customerDiscount: true,
  };
}

/** Prices one order line: sale rate, and the company discount (or the slab the quantity reaches). */
export function priceLine(product: PricedProduct, quantity: number): PricedLine {
  const discount = resolveDiscount(
    { discountType: product.discountType, discountValue: product.discountValue },
    product.tiers,
    quantity,
  );
  const amounts = calculateLineAmounts({
    quantity,
    baseUnitsPerPriceUnit: PACKETS_PER_DOZEN,
    rate: product.saleRate,
    discountType: discount.discountType,
    discountValue: discount.discountValue,
  });
  return {
    productId: product.id,
    companyId: product.companyId,
    quantity,
    rate: D(product.saleRate),
    discountType: discount.discountType,
    discountValue: D(discount.discountValue),
    ...amounts,
  };
}

export type Totals = {
  grossAmount: Decimal;
  discountAmount: Decimal;
  taxAmount: Decimal;
  netAmount: Decimal;
  quantity: number;
  /** The bill's special discount (or this company's share of it); included in discountAmount. */
  specialDiscount: Decimal;
};

const emptyTotals = (): Totals => ({
  grossAmount: ZERO,
  discountAmount: ZERO,
  taxAmount: ZERO,
  netAmount: ZERO,
  quantity: 0,
  specialDiscount: ZERO,
});

function add(
  t: Totals,
  l: Pick<PricedLine, "grossAmount" | "discountAmount" | "taxAmount" | "netAmount" | "quantity">,
): Totals {
  return {
    grossAmount: t.grossAmount.add(l.grossAmount),
    discountAmount: t.discountAmount.add(l.discountAmount),
    taxAmount: t.taxAmount.add(l.taxAmount),
    netAmount: t.netAmount.add(l.netAmount),
    quantity: t.quantity + l.quantity,
    specialDiscount: t.specialDiscount,
  };
}

/**
 * Splits a special discount over the bill's companies in proportion to their amounts, in paisa;
 * the rounding difference goes to the largest company, so the shares add up exactly. Never more
 * than the bill (capped at its total).
 */
export function splitSpecialDiscount(
  byCompanyNet: Map<string, DecimalValue>,
  special: DecimalValue,
): Map<string, Decimal> {
  const nets = [...byCompanyNet].map(([id, v]) => [id, Decimal.max(D(v), ZERO)] as const);
  const total = nets.reduce((s, [, v]) => s.add(v), ZERO);
  const amount = Decimal.min(Decimal.max(D(special), ZERO), total);
  const shares = new Map<string, Decimal>();
  if (amount.isZero()) return shares;
  let given = ZERO;
  for (const [id, net] of nets) {
    const share = amount.mul(net).div(total).toDecimalPlaces(2, Decimal.ROUND_DOWN);
    shares.set(id, share);
    given = given.add(share);
  }
  const largest = nets.reduce((a, b) => (b[1].gt(a[1]) ? b : a))[0];
  shares.set(largest, shares.get(largest)!.add(amount.sub(given)));
  return shares;
}

/**
 * Bill totals, overall and per company (each company's slice posts to its customer ledger). A
 * special discount on the whole bill is taken off each company's slice by its share
 * (splitSpecialDiscount) and counted in the discount.
 */
export function billTotals(
  lines: Pick<
    PricedLine,
    "companyId" | "grossAmount" | "discountAmount" | "taxAmount" | "netAmount" | "quantity"
  >[],
  specialDiscount: DecimalValue = 0,
) {
  let total = emptyTotals();
  const byCompany = new Map<string, Totals>();
  for (const line of lines) {
    total = add(total, line);
    byCompany.set(line.companyId, add(byCompany.get(line.companyId) ?? emptyTotals(), line));
  }
  const shares = splitSpecialDiscount(
    new Map([...byCompany].map(([id, t]) => [id, t.netAmount])),
    specialDiscount,
  );
  for (const [id, share] of shares) {
    const t = byCompany.get(id)!;
    byCompany.set(id, {
      ...t,
      discountAmount: t.discountAmount.add(share),
      netAmount: t.netAmount.sub(share),
      specialDiscount: share,
    });
    total = {
      ...total,
      discountAmount: total.discountAmount.add(share),
      netAmount: total.netAmount.sub(share),
      specialDiscount: total.specialDiscount.add(share),
    };
  }
  return { total, byCompany };
}

/**
 * A special discount as typed under the grid: rupees off the whole bill, from 0 up to the bill's
 * amount. Blank = none.
 */
export function readSpecialDiscount(
  value: string | null | undefined,
  billAmount: DecimalValue,
): { discount: Decimal; error?: string } {
  const text = (value ?? "").trim().replace(/,/g, "");
  if (text === "") return { discount: ZERO };
  if (!/^\d+(\.\d{1,2})?$/.test(text))
    return { discount: ZERO, error: "Special discount: an amount in rupees, e.g. 50" };
  const discount = D(text);
  if (discount.gt(D(billAmount)))
    return { discount: ZERO, error: "Special discount: cannot be more than the bill" };
  return { discount };
}

export type CreditCheck = {
  limit: Decimal | null;
  /** Ledger balance now (posted bills minus payments). */
  pending: Decimal;
  /** Booked / planned orders not yet posted, other than this one. */
  openOrders: Decimal;
  thisOrder: Decimal;
  /** pending + open orders + this order. */
  exposure: Decimal;
  /** How far past the limit (null when within it, or no limit). */
  over: Decimal | null;
};

/** Would this order take the customer past their credit limit? */
export function checkCredit(input: {
  creditLimit: DecimalValue | null;
  pending: DecimalValue;
  openOrders: DecimalValue;
  thisOrder: DecimalValue;
}): CreditCheck {
  const pending = D(input.pending);
  const openOrders = D(input.openOrders);
  const thisOrder = D(input.thisOrder);
  const exposure = pending.add(openOrders).add(thisOrder);
  const limit = input.creditLimit === null ? null : D(input.creditLimit);
  const over = limit !== null && exposure.gt(limit) && thisOrder.gt(0) ? exposure.sub(limit) : null;
  return { limit, pending, openOrders, thisOrder, exposure, over };
}

/**
 * The least the customer should pay against a bill: everything left over from earlier bills, or
 * whatever takes the total due back within the credit limit, whichever is more. With no limit it is
 * just the earlier balance. Never below zero (an advance in hand means nothing is owed yet).
 */
export function minimumPayment(input: {
  previous: DecimalValue;
  totalDue: DecimalValue;
  creditLimit: DecimalValue | null;
}): Decimal {
  const previous = D(input.previous);
  const overLimit =
    input.creditLimit === null ? new Decimal(0) : D(input.totalDue).sub(input.creditLimit);
  return Decimal.max(previous, overLimit, 0);
}

// ───────────── Status machine (SPEC §6) ─────────────

export const ORDER_STATUSES = [
  "BOOKED",
  "PLANNED",
  "DISPATCHED",
  "DELIVERED",
  "PARTIALLY_DELIVERED",
  "RETURNED",
  "CANCELLED",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Booked → Planned → Dispatched → Delivered / Partially delivered / Returned. Booked and planned
 * orders can be cancelled (or moved back to booked). After dispatch, only day-end reconciliation
 * changes an order.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  BOOKED: ["PLANNED", "DISPATCHED", "CANCELLED"],
  PLANNED: ["BOOKED", "DISPATCHED", "CANCELLED"],
  DISPATCHED: ["DELIVERED", "PARTIALLY_DELIVERED", "RETURNED"],
  DELIVERED: [],
  PARTIALLY_DELIVERED: [],
  RETURNED: [],
  CANCELLED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/** Orders can be edited (and still reserve stock) until they are dispatched. */
export function isOpenOrder(status: OrderStatus): boolean {
  return status === "BOOKED" || status === "PLANNED";
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  BOOKED: "Booked",
  PLANNED: "Planned",
  DISPATCHED: "Dispatched",
  DELIVERED: "Delivered",
  PARTIALLY_DELIVERED: "Partly delivered",
  RETURNED: "Returned",
  CANCELLED: "Cancelled",
};
