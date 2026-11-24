import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { formatMoney } from "@/lib/format";
import { checkCredit } from "@/lib/sales";
import { type CounterSaleInput, counterSaleSchema } from "@/lib/validation/sales";

import { writeAudit } from "../../audit";
import { assertCan } from "../../auth/permissions";
import type { TenantTx } from "../../db/tenant";
import { ServiceError } from "../errors";
import type { ServiceCtx } from "../master/common";
import { postCustomerPayment, reversePayment } from "../payments/customer-payments";
import { found, reverseLedgerFor } from "../posting";
import { type DiscountChange, saveDiscountChanges } from "./customer-discounts";
import {
  bookOrder,
  creditDecision,
  lineDiscount,
  lineRows,
  loadProducts,
  priceLines,
  totalsWithSpecial,
  writeBillRevision,
} from "./orders";
import { customerPending, openOrdersTotal } from "./positions";
import { assertStockOnHand, postOrderBill, stockOut } from "./post-bill";

// Counter sales: a customer (always a real customer record) collects the goods at the warehouse.
// One transaction does what booking, dispatch and day-end do for a delivery:
//  - books the order and its bill (same pricing, discounts and credit check as an order; going
//    past the credit limit needs the owner, since there is no later approval step);
//  - takes the stock out (refused if the warehouse is short) and posts the bill to the customer
//    ledger, one entry per company;
//  - records what was paid at the counter as a customer payment (oldest debt first, like money
//    collected on delivery); the rest stays on the customer's account;
//  - marks the order Delivered, with no trip and no day-end.

const D = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v);

export async function createCounterSale(ctx: ServiceCtx, input: unknown) {
  assertCan(ctx.user.role, "operations.manage");
  const data = counterSaleSchema.parse(input);
  const paid = data.paidAmount ? D(data.paidAmount) : D(0);
  return ctx.db.$transaction(
    async (tx) => {
      if (data.requestId) {
        const existing = await tx.salesOrder.findUnique({
          where: { tenantId_requestId: { tenantId: ctx.user.tenantId, requestId: data.requestId } },
          select: { id: true, number: true },
        });
        if (existing) return { ...existing, repeated: true };
      }
      const { order, bill, customer, warehouseId, lines, total, names } = await bookOrder(
        tx,
        ctx,
        {
          customerId: data.customerId,
          newCustomerName: data.newCustomerName,
          newCustomerPhone: data.newCustomerPhone,
          newCustomerAreaId: data.newCustomerAreaId,
          warehouseId: data.warehouseId,
          orderDate: data.saleDate,
          deliveryDate: data.saleDate,
          source: "OFFICE",
          note: data.note,
          requestId: data.requestId,
          allowOverCredit: data.allowOverCredit,
          lines: data.lines,
          specialDiscount: data.specialDiscount,
        },
        { fulfilment: "COUNTER", paidNow: paid },
      );

      const saleLines = lines.map((l) => ({
        productId: l.productId,
        companyId: l.companyId,
        quantity: l.quantity,
        netAmount: D(l.netAmount.toString()),
        product: { name: names.get(l.productId)! },
      }));
      await assertStockOnHand(tx, warehouseId, saleLines);
      const batchLeft = new Map<string, { id: string; available: number }[]>();
      for (const l of saleLines)
        await stockOut(
          tx,
          ctx,
          {
            productId: l.productId,
            warehouseId,
            quantity: l.quantity,
            orderId: order.id,
            at: data.saleDate,
          },
          batchLeft,
        );
      await postOrderBill(tx, ctx, { ...order, lines: saleLines, bill }, data.saleDate);
      await tx.salesOrder.update({
        where: { id: order.id },
        data: { status: "DELIVERED", reconciledAt: new Date(), reconciledById: ctx.user.id },
      });

      const payment = paid.gt(0)
        ? await postCounterPayment(tx, ctx, data, paid, customer.id, order)
        : null;

      await writeAudit(tx, ctx.user, {
        action: "POST",
        entityType: "SalesOrder",
        entityId: order.id,
        oldValue: { status: "BOOKED" },
        newValue: {
          status: "DELIVERED",
          fulfilment: "COUNTER",
          bill: total.netAmount,
          paid: payment ? { number: payment.number, amount: paid, method: data.method } : null,
        },
        requestId: data.requestId,
      });
      return { id: order.id, number: order.number, repeated: false };
    },
    // Serializable: like dispatch, two sales at once must not both take the same stock.
    { timeout: 60_000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

/** What was paid at the counter, as a customer payment tied to the sale. */
async function postCounterPayment(
  tx: TenantTx,
  ctx: ServiceCtx,
  data: CounterSaleInput,
  paid: Prisma.Decimal,
  customerId: string,
  order: { id: string; number: number },
) {
  const { payment } = await postCustomerPayment(tx, ctx, {
    customerId,
    paymentDate: data.saleDate,
    method: data.method,
    amount: paid,
    reference: data.method === "ONLINE" ? data.reference : null,
    cheque:
      data.method === "CHEQUE"
        ? { chequeNo: data.chequeNo!, bankName: data.bankName!, chequeDate: data.chequeDate! }
        : undefined,
    collectedVia: "OFFICE",
    salesOrderId: order.id,
    note: `At the counter, order #${order.number}`,
  });
  return payment;
}

type OwnPayment = {
  amount: Prisma.Decimal;
  method: string;
  paymentDate: Date;
  reference: string | null;
  cheque: { chequeNo: string; bankName: string; chequeDate: Date } | null;
};

/** The sale's payment is exactly what the corrected sale says was paid (amount, how, when). */
function samePayment(own: OwnPayment[], data: CounterSaleInput, paid: Prisma.Decimal) {
  if (own.length === 0) return paid.isZero();
  if (own.length > 1) return false;
  const p = own[0]!;
  if (!p.amount.eq(paid) || p.method !== data.method) return false;
  if (p.paymentDate.getTime() !== data.saleDate.getTime()) return false;
  if (p.method === "ONLINE") return (p.reference ?? null) === (data.reference ?? null);
  if (p.method === "CHEQUE")
    return (
      p.cheque?.chequeNo === data.chequeNo &&
      p.cheque?.bankName === data.bankName &&
      p.cheque?.chequeDate.getTime() === data.chequeDate?.getTime()
    );
  return true;
}

/**
 * Corrects a counter sale after it was saved (a wrong item, quantity, discount or payment), so the
 * bill can be printed again. The bill keeps its number and gets a new revision. Nothing posted is
 * edited (CLAUDE.md rule 2): the old stock movements and bill entries get mirror entries dated on
 * the original sale day, then the corrected sale is posted like a new one. The payment taken at
 * the counter stays as it is when "Paid now" did not change; otherwise it is reversed and taken
 * again (a cleared cheque cannot be). The customer cannot change.
 */
export async function editCounterSale(ctx: ServiceCtx, id: string, input: unknown) {
  assertCan(ctx.user.role, "operations.manage");
  const data = counterSaleSchema.parse(input);
  const paid = data.paidAmount ? D(data.paidAmount) : D(0);
  return ctx.db.$transaction(
    async (tx) => {
      const before = found(
        await tx.salesOrder.findUnique({
          where: { id },
          include: {
            lines: true,
            bill: true,
            payments: { where: { status: "POSTED" }, include: { cheque: true } },
          },
        }),
        "sale",
      );
      if (before.fulfilment !== "COUNTER" || before.status !== "DELIVERED" || !before.bill)
        throw new ServiceError("Only a saved counter sale can be corrected here.");
      if (data.customerId !== before.customerId)
        throw new ServiceError(
          "The customer of a sale cannot change. Make a new sale for the right customer instead.",
        );
      const bill = before.bill;
      const oldDate = bill.billDate;
      const note = `Counter sale #${before.number} corrected`;

      // The corrected lines, priced like a new sale.
      const products = await loadProducts(
        tx,
        before.warehouseId,
        data.lines.map((l) => l.productId),
      );
      const lines = priceLines(products, data);
      const { total } = totalsWithSpecial(lines, data.specialDiscount);
      const netAmount = D(total.netAmount.toString());

      // Payments already put against this bill must still fit in it. The sale's own payment is
      // simply taken again when it no longer fits; another payment has to be reversed first.
      const own = before.payments;
      const ownIds = new Set(own.map((p) => p.id));
      const allocations = await tx.paymentAllocation.findMany({
        where: { billId: bill.id, customerPayment: { status: "POSTED" } },
        select: { customerPaymentId: true, amount: true },
      });
      const allocated = (onlyOthers: boolean) =>
        allocations
          .filter((a) => !onlyOthers || !ownIds.has(a.customerPaymentId))
          .reduce((s, a) => s.add(a.amount), D(0));
      if (allocated(true).gt(netAmount))
        throw new ServiceError(
          `Later payments already paid ${formatMoney(allocated(true))} of this bill, more than the corrected bill. Reverse those payments first.`,
        );
      const keepPayment = samePayment(own, data, paid) && !allocated(false).gt(netAmount);

      if (!keepPayment) {
        const cleared = own.find((p) => p.cheque?.status === "CLEARED");
        if (cleared)
          throw new ServiceError(
            `Payment #${cleared.number} is a cheque that has already cleared, so what was paid cannot change. Keep "Paid now" as it was.`,
          );
        for (const p of own) await reversePayment(tx, ctx, p.id, note, "REVERSAL", p.paymentDate);
      }

      // Put the old sale back: its stock returns to the warehouse, its bill leaves the ledger.
      const moves = await tx.stockMovement.findMany({
        where: {
          referenceType: "SalesOrder",
          referenceId: id,
          type: "DISPATCH",
          reversedBy: { none: {} },
        },
      });
      for (const m of moves)
        await tx.stockMovement.create({
          data: {
            tenantId: ctx.user.tenantId,
            type: "REVERSAL",
            productId: m.productId,
            warehouseId: m.warehouseId,
            batchId: m.batchId,
            bucket: m.bucket,
            quantity: -m.quantity,
            occurredAt: m.occurredAt,
            referenceType: "SalesOrder",
            referenceId: id,
            reversalOfId: m.id,
            note,
            createdById: ctx.user.id,
          },
        });
      await reverseLedgerFor(
        tx,
        ctx,
        { type: "Bill", id: bill.id },
        oldDate,
        `Bill #${bill.number}: ${note}`,
      );

      // Credit limit: only when more goes on account than before (a smaller bill always passes).
      const oldPaid = own.reduce((s, p) => s.add(p.amount), D(0));
      const oldOnAccount = Prisma.Decimal.max(bill.netAmount.sub(oldPaid), 0);
      const newOnAccount = Prisma.Decimal.max(netAmount.sub(paid), 0);
      let decision = { needsCreditApproval: false, override: false };
      if (newOnAccount.gt(oldOnAccount)) {
        const customer = await tx.customer.findUniqueOrThrow({ where: { id: before.customerId } });
        const pending = await customerPending(tx, customer.id);
        const credit = checkCredit({
          creditLimit: customer.creditLimit?.toString() ?? null,
          pending: pending.total.toString(),
          openOrders: (await openOrdersTotal(tx, customer.id)).toString(),
          // A kept payment is still in the ledger (in `pending`).
          thisOrder: (keepPayment ? netAmount : newOnAccount).toString(),
        });
        decision = creditDecision(ctx, credit, data.allowOverCredit);
        if (decision.needsCreditApproval)
          throw new ServiceError(
            `This sale takes the customer ${formatMoney(credit.over)} past their credit limit of ${formatMoney(credit.limit)}. Take more payment now, or ask the owner to allow it.`,
          );
      }

      // The corrected sale: stock out and the bill back in the ledger, on the sale date.
      const names = new Map([...products.values()].map((p) => [p.id, p.name]));
      const saleLines = lines.map((l) => ({
        productId: l.productId,
        companyId: l.companyId,
        quantity: l.quantity,
        netAmount: D(l.netAmount.toString()),
        product: { name: names.get(l.productId)! },
      }));
      await assertStockOnHand(tx, before.warehouseId, saleLines);
      const batchLeft = new Map<string, { id: string; available: number }[]>();
      for (const l of saleLines)
        await stockOut(
          tx,
          ctx,
          {
            productId: l.productId,
            warehouseId: before.warehouseId,
            quantity: l.quantity,
            orderId: id,
            at: data.saleDate,
          },
          batchLeft,
        );
      if (netAmount.gt(0))
        await tx.ledgerEntry.create({
          data: {
            tenantId: ctx.user.tenantId,
            partyType: "CUSTOMER",
            customerId: before.customerId,
            type: "SALES_BILL",
            entryDate: data.saleDate,
            debit: netAmount,
            description: `Bill #${bill.number} (order #${before.number}), corrected`,
            referenceType: "Bill",
            referenceId: bill.id,
            createdById: ctx.user.id,
          },
        });

      // A discount changed on this correction becomes the customer's own, as on an order edit.
      const beforeLine = new Map(before.lines.map((l) => [l.productId, lineDiscount(l)]));
      const changes: DiscountChange[] = lines
        .filter((l) => beforeLine.has(l.productId))
        .map((l) => ({
          productId: l.productId,
          before: beforeLine.get(l.productId)!,
          after: lineDiscount(l),
        }));
      await saveDiscountChanges(tx, ctx, before.customerId, changes, id);

      await tx.salesOrderLine.deleteMany({ where: { salesOrderId: id } });
      await tx.salesOrderLine.createMany({
        data: lineRows(ctx, lines).map((l) => ({ ...l, salesOrderId: id })),
      });
      await tx.salesOrder.update({
        where: { id },
        data: {
          orderDate: data.saleDate,
          deliveryDate: data.saleDate,
          note: data.note,
          specialDiscount: D(total.specialDiscount.toString()),
          ...(decision.override
            ? { creditOverrideById: ctx.user.id, creditOverrideAt: new Date() }
            : {}),
        },
      });
      // The previous balance printed on the bill stays as frozen when the sale was first saved.
      const revision = bill.currentRevision + 1;
      await tx.bill.update({
        where: { id: bill.id },
        data: {
          billDate: data.saleDate,
          currentRevision: revision,
          grossAmount: D(total.grossAmount.toString()),
          discountAmount: D(total.discountAmount.toString()),
          taxAmount: D(total.taxAmount.toString()),
          netAmount,
        },
      });
      await writeBillRevision(
        tx,
        ctx,
        bill.id,
        revision,
        "Corrected after the sale",
        lines,
        total.specialDiscount.toString(),
      );

      const payment =
        !keepPayment && paid.gt(0)
          ? await postCounterPayment(tx, ctx, data, paid, before.customerId, before)
          : null;

      await writeAudit(tx, ctx.user, {
        action: "UPDATE",
        entityType: "SalesOrder",
        entityId: id,
        oldValue: {
          saleDate: oldDate,
          lines: before.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
          bill: bill.netAmount,
          paid: own.map((p) => ({ number: p.number, amount: p.amount, method: p.method })),
        },
        newValue: {
          saleDate: data.saleDate,
          lines: lines.map((l) => ({
            productId: l.productId,
            quantity: l.quantity,
            ...(l.customerDiscount ? { customerDiscount: l.discountValue } : {}),
          })),
          bill: netAmount,
          paid: keepPayment
            ? "unchanged"
            : payment
              ? { number: payment.number, amount: paid, method: data.method }
              : null,
          revision,
        },
      });
      return { id, number: before.number };
    },
    // Serializable: like a new sale, two at once must not both take the same stock.
    { timeout: 60_000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
