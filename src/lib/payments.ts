import Decimal from "decimal.js";

// Customer payment allocation (SPEC §8), shared by the server and the payment screen. Pure.
//
// Each customer has one account (no company split). A payment goes to the oldest debt first:
// debt the bills cannot explain (the old balance of paper bills from before the app, and an
// opening balance) comes first, then posted bills, oldest first. Anything left over is an advance.

type DecimalValue = Decimal | number | string;
const D = (v: DecimalValue) => new Decimal(v);
const ZERO = new Decimal(0);

export type BillDebt = {
  billId: string;
  number: number;
  /** Unpaid amount of the bill (its total less what payments have been allocated to it). */
  outstanding: DecimalValue;
};

export type Allocation = { billId: string; amount: Decimal };

export type PaymentSplit = {
  /** Rows to store as PaymentAllocation. */
  allocations: Allocation[];
  /** Paid towards the old balance / opening balance (debt with no bill). */
  unbilled: Decimal;
  /** Not owed anywhere: an advance on the customer's account. */
  advance: Decimal;
};

/**
 * What the customer really owes, bill by bill. `owed` is the ledger balance: when it is less than
 * the unpaid bills (an earlier advance, a return), the difference pays off the oldest bills first;
 * when it is more, the difference is `unbilled` (old balance, opening balance).
 */
export function effectiveDebt(owed: DecimalValue, bills: BillDebt[]) {
  const total = bills.reduce((s, b) => s.add(b.outstanding), ZERO);
  const diff = D(owed).sub(total);
  let credit = diff.lt(0) ? diff.neg() : ZERO;
  const effective = bills
    .map((b) => {
      const out = D(b.outstanding);
      const used = Decimal.min(credit, out);
      credit = credit.sub(used);
      return { billId: b.billId, number: b.number, outstanding: out.sub(used) };
    })
    .filter((b) => b.outstanding.gt(0));
  return { unbilled: diff.gt(0) ? diff : ZERO, bills: effective };
}

/** Oldest debt first (see the file comment). Bills must be oldest first. */
export function allocateOldestFirst(
  amount: DecimalValue,
  debt: { unbilled: Decimal; bills: { billId: string; outstanding: DecimalValue }[] },
): PaymentSplit {
  let left = D(amount);
  const unbilled = Decimal.min(Decimal.max(left, ZERO), debt.unbilled);
  left = left.sub(unbilled);
  const allocations: Allocation[] = [];
  for (const bill of debt.bills) {
    if (left.lte(0)) break;
    const take = Decimal.min(left, D(bill.outstanding));
    if (take.lte(0)) continue;
    allocations.push({ billId: bill.billId, amount: take });
    left = left.sub(take);
  }
  return { allocations, unbilled, advance: left.gt(0) ? left : ZERO };
}

export const CHEQUE_STATUS_LABEL = {
  PENDING: "Pending",
  CLEARED: "Cleared",
  BOUNCED: "Bounced",
} as const;
