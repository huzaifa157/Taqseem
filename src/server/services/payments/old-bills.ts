import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { businessToday, formatDate } from "@/lib/dates";
import { formatMoney } from "@/lib/format";
import { oldBillSchema } from "@/lib/validation/payments";
import { reverseSchema } from "@/lib/validation/purchasing";

import { writeAudit } from "../../audit";
import { assertCan } from "../../auth/permissions";
import { ServiceError } from "../errors";
import type { ServiceCtx } from "../master/common";
import { found, reverseLedgerFor } from "../posting";
import type { TenantTx } from "../../db/tenant";
import { customerDebt } from "./customer-payments";

type Reader = TenantTx | ServiceCtx["db"];

/**
 * How much of the customer's old balance is still unpaid. Debt no bill explains is the old
 * balance plus any opening balance; payments clear the old balance first, so what is left of
 * that debt beyond the opening balance is the unpaid old balance (never more than the bills).
 */
async function oldBalanceLeft(tx: Reader, customerId: string) {
  const [{ debt }, bills, opening] = await Promise.all([
    customerDebt(tx, customerId),
    tx.customerOldBill.aggregate({
      where: { customerId, status: "POSTED" },
      _sum: { amount: true },
    }),
    tx.ledgerEntry.aggregate({
      where: {
        partyType: "CUSTOMER",
        customerId,
        type: "OPENING_BALANCE",
        OR: [{ referenceType: null }, { referenceType: { not: "CustomerOldBill" } }],
      },
      _sum: { debit: true, credit: true },
    }),
  ]);
  const openingBalance = Prisma.Decimal.max(
    D(opening._sum.debit ?? 0).sub(opening._sum.credit ?? 0),
    0,
  );
  const left = Prisma.Decimal.max(D(debt.unbilled.toString()).sub(openingBalance), 0);
  return Prisma.Decimal.min(left, bills._sum.amount ?? D(0));
}

// The customer's old balance: unpaid paper bills from before the app. Each posts a customer
// OPENING_BALANCE ledger entry (referenceType CustomerOldBill) on their one account. Payments
// settle it before anything else (src/lib/payments.ts). Removing one posts a reversal; it is never
// edited.

const D = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v);

/**
 * How the entry reads on the statement: a paper bill by its number, otherwise an amount added to
 * the customer's balance (from Ledgers or the order screen), with its note.
 */
const label = (b: { billNo: string | null; billDate: Date; note: string | null }) =>
  b.billNo
    ? `Old bill #${b.billNo} of ${formatDate(b.billDate)}`
    : `Added to balance${b.note ? `: ${b.note}` : ""}`;

export async function createOldBill(ctx: ServiceCtx, input: unknown) {
  assertCan(ctx.user.role, "payments.manage");
  const data = oldBillSchema.parse(input);
  return ctx.db.$transaction(async (tx) => {
    if (data.requestId) {
      const existing = await tx.customerOldBill.findUnique({
        where: { tenantId_requestId: { tenantId: ctx.user.tenantId, requestId: data.requestId } },
      });
      if (existing) return existing;
    }
    found(await tx.customer.findUnique({ where: { id: data.customerId } }), "customer");
    const bill = await tx.customerOldBill.create({
      data: {
        tenantId: ctx.user.tenantId,
        customerId: data.customerId,
        billDate: data.billDate,
        billNo: data.billNo,
        amount: D(data.amount),
        note: data.note,
        requestId: data.requestId,
        createdById: ctx.user.id,
      },
    });
    await tx.ledgerEntry.create({
      data: {
        tenantId: ctx.user.tenantId,
        partyType: "CUSTOMER",
        customerId: data.customerId,
        companyId: null,
        type: "OPENING_BALANCE",
        entryDate: data.billDate,
        debit: bill.amount,
        description: label(bill),
        referenceType: "CustomerOldBill",
        referenceId: bill.id,
        requestId: data.requestId,
        createdById: ctx.user.id,
      },
    });
    await writeAudit(tx, ctx.user, {
      action: "CREATE",
      entityType: "CustomerOldBill",
      entityId: bill.id,
      newValue: bill,
      requestId: data.requestId,
    });
    return bill;
  });
}

/** Takes an old bill back out (entered by mistake). Refused once payments have used it up. */
export async function removeOldBill(ctx: ServiceCtx, input: unknown) {
  assertCan(ctx.user.role, "payments.manage");
  const { id, reason } = reverseSchema.parse(input);
  // Serializable: a payment at the same time must not pay off what is being removed.
  return ctx.db.$transaction(
    async (tx) => {
      const bill = found(await tx.customerOldBill.findUnique({ where: { id } }), "old bill");
      // Before this bill comes off, what is unpaid of the old balance must cover it.
      const oldBalance = await oldBalanceLeft(tx, bill.customerId);
      const claimed = await tx.customerOldBill.updateMany({
        where: { id, status: "POSTED" },
        data: { status: "REVERSED", reversedAt: new Date(), reversalReason: reason },
      });
      if (claimed.count === 0) throw new ServiceError("This old bill is already removed.");
      if (oldBalance.lt(bill.amount)) {
        throw new ServiceError(
          `Only ${formatMoney(oldBalance.toFixed(2))} of the old balance is unpaid, so this bill of ${formatMoney(bill.amount.toFixed(2))} can't be removed. Reverse the payments first.`,
        );
      }
      await reverseLedgerFor(
        tx,
        ctx,
        { type: "CustomerOldBill", id },
        businessToday(),
        `Removed: ${label(bill)} (${reason})`,
      );
      await writeAudit(tx, ctx.user, {
        action: "REVERSE",
        entityType: "CustomerOldBill",
        entityId: id,
        oldValue: { status: "POSTED", amount: bill.amount },
        newValue: { status: "REVERSED", reason },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

/**
 * A customer's old bills, oldest first, with how much of each is paid: payments to the old balance
 * pay the oldest bill first.
 */
export async function listOldBills(ctx: ServiceCtx, customerId: string) {
  assertCan(ctx.user.role, "ledgers.view");
  const [customer, bills, pending] = await Promise.all([
    ctx.db.customer.findUnique({
      where: { id: customerId },
      select: { id: true, name: true, shopName: true },
    }),
    ctx.db.customerOldBill.findMany({
      where: { customerId },
      orderBy: [{ billDate: "asc" }, { createdAt: "asc" }],
    }),
    oldBalanceLeft(ctx.db, customerId),
  ]);
  const posted = bills.filter((b) => b.status === "POSTED");
  const total = posted.reduce((s, b) => s.add(b.amount), D(0));
  let paid = Prisma.Decimal.max(total.sub(pending), 0);
  const paidOf = new Map<string, Prisma.Decimal>();
  for (const b of posted) {
    const part = Prisma.Decimal.min(paid, b.amount);
    paidOf.set(b.id, part);
    paid = paid.sub(part);
  }
  return {
    customer: found(customer, "customer"),
    rows: bills.map((b) => ({
      ...b,
      paid: paidOf.get(b.id) ?? D(0),
      unpaid: b.status === "POSTED" ? b.amount.sub(paidOf.get(b.id) ?? 0) : D(0),
    })),
    total,
    unpaid: pending,
  };
}
