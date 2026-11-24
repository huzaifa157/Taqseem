import "server-only";

import { Prisma } from "@/generated/prisma/client";
import type {
  ChequeStatus,
  PaymentCollectedVia,
  PaymentMethod,
  PostingStatus,
} from "@/generated/prisma/enums";
import { businessToday, formatDate } from "@/lib/dates";
import { formatMoney } from "@/lib/format";
import { icontains, matchEveryWord, searchNumber } from "@/lib/list-params";
import { allocateOldestFirst, type BillDebt, effectiveDebt } from "@/lib/payments";
import { recordIdSchema } from "@/lib/validation/master";
import { customerPaymentSchema } from "@/lib/validation/payments";
import { reverseSchema } from "@/lib/validation/purchasing";

import { writeAudit } from "../../audit";
import { assertCan } from "../../auth/permissions";
import type { TenantTx } from "../../db/tenant";
import { ServiceError } from "../errors";
import { PAGE_SIZE, paged, type ServiceCtx } from "../master/common";
import { found, nextDocumentNumber, reverseLedgerFor } from "../posting";
import type { DateRange } from "../purchasing/filters";
import { customerPending } from "../sales/positions";

// Customer payments (SPEC §8), at the office or collected at delivery (day-end). Allocation rules
// are in src/lib/payments.ts: oldest debt first (opening balance, then bills oldest first, a
// multi-company bill split by each company's unpaid amount), or a manual split by company. Each
// company's share credits that company's slice of the customer ledger.
// A bounced cheque reverses its payment (the debt comes back) and flags the customer.

const D = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v);
type Reader = TenantTx | ServiceCtx["db"];

/**
 * Everything the customer owes, bill by bill: posted bills less the payments allocated to them,
 * and the debt no bill explains (old balance, opening balance). One account, no companies.
 */
export async function customerDebt(tx: Reader, customerId: string) {
  const [pending, bills] = await Promise.all([
    customerPending(tx, customerId),
    tx.bill.findMany({
      where: { customerId, status: "POSTED", postedAt: { not: null } },
      orderBy: [{ billDate: "asc" }, { number: "asc" }],
      select: { id: true, number: true, billDate: true, netAmount: true },
    }),
  ]);
  const paid = await tx.paymentAllocation.groupBy({
    by: ["billId"],
    where: { billId: { in: bills.map((b) => b.id) }, customerPayment: { status: "POSTED" } },
    _sum: { amount: true },
  });
  const paidOf = new Map(paid.map((p) => [p.billId, p._sum.amount ?? D(0)]));
  const raw: BillDebt[] = bills
    .map((b) => ({
      billId: b.id,
      number: b.number,
      outstanding: b.netAmount.sub(paidOf.get(b.id) ?? 0).toString(),
    }))
    .filter((b) => D(b.outstanding).gt(0));
  return {
    pending,
    debt: effectiveDebt(pending.total.toString(), raw),
    billDates: new Map(bills.map((b) => [b.id, b.billDate])),
  };
}

export type CustomerPaymentPost = {
  customerId: string;
  paymentDate: Date;
  method: PaymentMethod;
  amount: Prisma.Decimal;
  reference?: string | null;
  cheque?: { chequeNo: string; bankName: string; chequeDate: Date };
  collectedVia: PaymentCollectedVia;
  salesOrderId?: string;
  note?: string | null;
  requestId?: string;
};

const methodLabel = (p: Pick<CustomerPaymentPost, "method" | "cheque" | "reference">) =>
  p.method === "CHEQUE"
    ? `Cheque ${p.cheque!.chequeNo} (${p.cheque!.bankName})`
    : p.method === "ONLINE"
      ? `Online${p.reference ? ` ${p.reference}` : ""}`
      : "Cash";

/** Saves one payment, its allocations and its ledger credits, inside the caller's transaction. */
export async function postCustomerPayment(tx: TenantTx, ctx: ServiceCtx, p: CustomerPaymentPost) {
  if (p.amount.lte(0)) throw new ServiceError("The amount must be more than zero.");
  const { debt } = await customerDebt(tx, p.customerId);
  const split = allocateOldestFirst(p.amount.toString(), debt);

  const cheque = p.cheque
    ? await tx.cheque.create({
        data: {
          tenantId: ctx.user.tenantId,
          direction: "RECEIVED",
          chequeNo: p.cheque.chequeNo,
          bankName: p.cheque.bankName,
          chequeDate: p.cheque.chequeDate,
          amount: p.amount,
        },
      })
    : null;
  const payment = await tx.customerPayment.create({
    data: {
      tenantId: ctx.user.tenantId,
      number: await nextDocumentNumber(tx, ctx, "CUSTOMER_PAYMENT"),
      customerId: p.customerId,
      paymentDate: p.paymentDate,
      method: p.method,
      amount: p.amount,
      reference: p.reference ?? null,
      chequeId: cheque?.id ?? null,
      collectedVia: p.collectedVia,
      salesOrderId: p.salesOrderId ?? null,
      note: p.note ?? null,
      requestId: p.requestId,
      createdById: ctx.user.id,
    },
  });
  await tx.ledgerEntry.create({
    data: {
      tenantId: ctx.user.tenantId,
      partyType: "CUSTOMER",
      customerId: p.customerId,
      type: "CUSTOMER_PAYMENT",
      entryDate: p.paymentDate,
      credit: p.amount,
      description: `${methodLabel(p)} received, payment #${payment.number}`,
      referenceType: "CustomerPayment",
      referenceId: payment.id,
      createdById: ctx.user.id,
    },
  });
  if (split.allocations.length > 0) {
    await tx.paymentAllocation.createMany({
      data: split.allocations.map((a) => ({
        tenantId: ctx.user.tenantId,
        customerPaymentId: payment.id,
        billId: a.billId,
        amount: D(a.amount.toString()),
      })),
    });
  }
  return {
    payment,
    allocations: split.allocations,
    toOldBalance: D(split.unbilled.toString()),
    advance: D(split.advance.toString()),
  };
}

// ───────────────────────── Office payments ─────────────────────────

export async function createCustomerPayment(ctx: ServiceCtx, input: unknown) {
  assertCan(ctx.user.role, "payments.manage");
  const data = customerPaymentSchema.parse(input);
  // Serializable: two payments for one customer at the same time must not both take one bill.
  return ctx.db.$transaction(
    async (tx) => {
      if (data.requestId) {
        const existing = await tx.customerPayment.findUnique({
          where: { tenantId_requestId: { tenantId: ctx.user.tenantId, requestId: data.requestId } },
        });
        if (existing) return existing;
      }
      const customer = await tx.customer.findUnique({ where: { id: data.customerId } });
      if (!customer) throw new ServiceError("Choose the customer.");
      const { payment, ...split } = await postCustomerPayment(tx, ctx, {
        customerId: customer.id,
        paymentDate: data.paymentDate,
        method: data.method,
        amount: D(data.amount),
        reference: data.method === "CHEQUE" ? null : data.reference,
        cheque:
          data.method === "CHEQUE"
            ? { chequeNo: data.chequeNo!, bankName: data.bankName!, chequeDate: data.chequeDate! }
            : undefined,
        collectedVia: "OFFICE",
        note: data.note,
        requestId: data.requestId,
      });
      await writeAudit(tx, ctx.user, {
        action: "POST",
        entityType: "CustomerPayment",
        entityId: payment.id,
        newValue: { ...payment, ...split },
        requestId: data.requestId,
      });
      return payment;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 },
  );
}

/** Undoes a payment: mirror ledger entries (the debt comes back) and its bills are unpaid again. */
export async function reversePayment(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
  reason: string,
  type: "REVERSAL" | "CHEQUE_BOUNCE",
  /** When the reversal is entered in the ledger (default today; a corrected sale: its date). */
  entryDate: Date = businessToday(),
) {
  const payment = found(
    await tx.customerPayment.findUnique({ where: { id }, include: { cheque: true } }),
    "payment",
  );
  const claimed = await tx.customerPayment.updateMany({
    where: { id, status: "POSTED" },
    data: { status: "REVERSED", reversedAt: new Date(), reversalReason: reason },
  });
  if (claimed.count === 0) throw new ServiceError("This payment is already reversed.");
  await reverseLedgerFor(
    tx,
    ctx,
    { type: "CustomerPayment", id },
    entryDate,
    `${type === "CHEQUE_BOUNCE" ? "Cheque bounced" : "Reversed"}: payment #${payment.number} (${reason})`,
    type,
  );
  return payment;
}

export async function reverseCustomerPayment(ctx: ServiceCtx, input: unknown) {
  assertCan(ctx.user.role, "payments.manage");
  const { id, reason } = reverseSchema.parse(input);
  return ctx.db.$transaction(async (tx) => {
    const payment = await reversePayment(tx, ctx, id, reason, "REVERSAL");
    if (payment.cheque?.status === "CLEARED")
      throw new ServiceError("This cheque has cleared. Record a refund instead of reversing it.");
    await writeAudit(tx, ctx.user, {
      action: "REVERSE",
      entityType: "CustomerPayment",
      entityId: id,
      oldValue: { status: "POSTED" },
      newValue: { status: "REVERSED", reason },
    });
  });
}

async function pendingCheque(tx: TenantTx, paymentId: string) {
  const payment = found(
    await tx.customerPayment.findUnique({ where: { id: paymentId }, include: { cheque: true } }),
    "payment",
  );
  if (!payment.cheque) throw new ServiceError("This payment is not a cheque.");
  if (payment.status !== "POSTED") throw new ServiceError("This payment was reversed.");
  if (payment.cheque.status !== "PENDING")
    throw new ServiceError(`This cheque is already ${payment.cheque.status.toLowerCase()}.`);
  return { payment, cheque: payment.cheque };
}

export async function clearCheque(ctx: ServiceCtx, input: unknown) {
  assertCan(ctx.user.role, "payments.manage");
  const { id } = recordIdSchema.parse(input);
  return ctx.db.$transaction(async (tx) => {
    const { cheque } = await pendingCheque(tx, id);
    await tx.cheque.update({
      where: { id: cheque.id },
      data: { status: "CLEARED", clearedAt: new Date() },
    });
    await writeAudit(tx, ctx.user, {
      action: "UPDATE",
      entityType: "Cheque",
      entityId: cheque.id,
      oldValue: { status: "PENDING" },
      newValue: { status: "CLEARED" },
    });
  });
}

/** Bounced cheque: reverses the payment, restores the balance and flags the customer. */
export async function bounceCheque(ctx: ServiceCtx, input: unknown) {
  assertCan(ctx.user.role, "payments.manage");
  const { id, reason } = reverseSchema.parse(input);
  return ctx.db.$transaction(async (tx) => {
    const { payment, cheque } = await pendingCheque(tx, id);
    await reversePayment(tx, ctx, id, reason, "CHEQUE_BOUNCE");
    await tx.cheque.update({
      where: { id: cheque.id },
      data: { status: "BOUNCED", bouncedAt: new Date() },
    });
    const flagReason = `Cheque ${cheque.chequeNo} (${cheque.bankName}) for ${formatMoney(cheque.amount)} bounced on ${formatDate(businessToday())}: ${reason}`;
    await tx.customer.update({
      where: { id: payment.customerId },
      data: { isFlagged: true, flagReason },
    });
    await writeAudit(tx, ctx.user, {
      action: "REVERSE",
      entityType: "Cheque",
      entityId: cheque.id,
      oldValue: { status: "PENDING", payment: payment.number },
      newValue: { status: "BOUNCED", reason, customerFlagged: true },
    });
  });
}

// ───────────────────────── Reading ─────────────────────────

export type PaymentFilters = {
  q?: string;
  customerId?: string;
  method?: string;
  status?: string;
  cheque?: string;
  via?: string;
  page: number;
} & DateRange;

const METHODS: PaymentMethod[] = ["CASH", "CHEQUE", "ONLINE"];
const STATUSES: PostingStatus[] = ["POSTED", "REVERSED"];
const CHEQUE_STATUSES: ChequeStatus[] = ["PENDING", "CLEARED", "BOUNCED"];
const VIA: PaymentCollectedVia[] = ["OFFICE", "DELIVERY"];
const pick = <T extends string>(list: T[], v?: string) =>
  v && list.includes(v as T) ? (v as T) : undefined;

export async function listCustomerPayments(ctx: ServiceCtx, f: PaymentFilters) {
  assertCan(ctx.user.role, "payments.manage");
  const number = searchNumber(f.q);
  const chequeStatus = pick(CHEQUE_STATUSES, f.cheque);
  const where: Prisma.CustomerPaymentWhereInput = {
    ...(f.customerId ? { customerId: f.customerId } : {}),
    ...(pick(METHODS, f.method) ? { method: pick(METHODS, f.method) } : {}),
    ...(pick(STATUSES, f.status) ? { status: pick(STATUSES, f.status) } : {}),
    ...(pick(VIA, f.via) ? { collectedVia: pick(VIA, f.via) } : {}),
    // A reversed payment's cheque is no longer waiting to clear.
    ...(chequeStatus
      ? {
          cheque: { status: chequeStatus },
          ...(chequeStatus === "PENDING" ? { status: "POSTED" as const } : {}),
        }
      : {}),
    ...(f.from || f.to
      ? { paymentDate: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } }
      : {}),
    // A number is a payment number, cheque number or online reference; otherwise every word in
    // the customer's name or shop, the reference or the cheque number.
    ...(number !== undefined
      ? {
          OR: [
            { number },
            { cheque: { chequeNo: { contains: String(number) } } },
            { reference: { contains: String(number) } },
          ],
        }
      : matchEveryWord(f.q, (w): Prisma.CustomerPaymentWhereInput[] => [
          { customer: { name: icontains(w) } },
          { customer: { shopName: icontains(w) } },
          { reference: icontains(w) },
          { cheque: { chequeNo: { contains: w } } },
        ])),
  };
  const [rows, total, sum] = await Promise.all([
    ctx.db.customerPayment.findMany({
      where,
      orderBy: [{ paymentDate: "desc" }, { number: "desc" }],
      skip: (f.page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        customer: { select: { name: true, shopName: true } },
        cheque: true,
      },
    }),
    ctx.db.customerPayment.count({ where }),
    ctx.db.customerPayment.aggregate({
      where: { AND: [where, { status: "POSTED" }] },
      _sum: { amount: true },
    }),
  ]);
  return { ...paged(rows, total, f.page), totalAmount: sum._sum.amount ?? D(0) };
}

export async function getCustomerPayment(ctx: ServiceCtx, id: string) {
  assertCan(ctx.user.role, "payments.manage");
  const p = found(
    await ctx.db.customerPayment.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, name: true, shopName: true } },
        cheque: true,
        salesOrder: { select: { id: true, number: true, tripId: true } },
        allocations: {
          include: {
            bill: { select: { id: true, number: true, billDate: true, salesOrderId: true } },
          },
        },
      },
    }),
    "payment",
  );
  const allocated = p.allocations.reduce((sum, a) => sum.add(a.amount), D(0));
  return {
    ...p,
    allocations: [...p.allocations].sort(
      (a, b) =>
        a.bill.billDate.getTime() - b.bill.billDate.getTime() || a.bill.number - b.bill.number,
    ),
    /** Not put against a bill: the old / opening balance, or an advance. */
    notOnBills: p.amount.sub(allocated),
  };
}

/** The payment screen's view of a customer: what they owe and their open bills, oldest first. */
export async function paymentContext(ctx: ServiceCtx, customerId: string) {
  assertCan(ctx.user.role, "payments.manage");
  const customer = found(
    await ctx.db.customer.findUnique({ where: { id: customerId } }),
    "customer",
  );
  const { pending, debt, billDates } = await customerDebt(ctx.db, customerId);
  return {
    customer: {
      id: customer.id,
      name: customer.name,
      shopName: customer.shopName,
      isFlagged: customer.isFlagged,
      flagReason: customer.flagReason,
    },
    pending: pending.total.toFixed(2),
    /** Owed with no bill: the old balance (paper bills) and an opening balance. Paid first. */
    unbilled: debt.unbilled.toFixed(2),
    bills: debt.bills.map((b) => ({
      billId: b.billId,
      number: b.number,
      billDate: billDates.get(b.billId)!.toISOString().slice(0, 10),
      outstanding: b.outstanding.toFixed(2),
    })),
  };
}

export type PaymentContext = Awaited<ReturnType<typeof paymentContext>>;

/** Removes the "flagged" mark (e.g. after a bounced cheque was made good). */
export async function clearCustomerFlag(ctx: ServiceCtx, input: unknown) {
  assertCan(ctx.user.role, "payments.manage");
  const { id } = recordIdSchema.parse(input);
  return ctx.db.$transaction(async (tx) => {
    const customer = found(await tx.customer.findUnique({ where: { id } }), "customer");
    if (!customer.isFlagged) throw new ServiceError("This customer is not flagged.");
    await tx.customer.update({ where: { id }, data: { isFlagged: false, flagReason: null } });
    await writeAudit(tx, ctx.user, {
      action: "UPDATE",
      entityType: "Customer",
      entityId: id,
      oldValue: { isFlagged: true, flagReason: customer.flagReason },
      newValue: { isFlagged: false },
    });
  });
}
