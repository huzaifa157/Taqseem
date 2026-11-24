import "server-only";

import { Prisma } from "@/generated/prisma/client";

import { minimumPayment } from "@/lib/sales";

import { assertCan } from "../../auth/permissions";
import type { ServiceCtx } from "../master/common";
import { ServiceError } from "../errors";
import { found } from "../posting";
import { customerPending } from "./positions";

// Bill view for screen and print: the current revision's lines, the split per company, and
// "previous pending + this bill = total due", overall and for each company's slice.

const D = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v);

type SnapshotLine = {
  productId: string;
  companyId: string;
  quantity: number;
  rate: string;
  discountType: string;
  discountValue: string;
  grossAmount: string;
  discountAmount: string;
  netAmount: string;
};
type SnapshotCompany = { companyId: string; netAmount: string; specialDiscount?: string };

export async function getBillView(ctx: ServiceCtx, orderId: string) {
  assertCan(ctx.user.role, "operations.manage");
  const order = found(
    await ctx.db.salesOrder.findUnique({
      where: { id: orderId },
      include: {
        customer: { include: { area: { select: { name: true } } } },
        bill: { include: { revisions: { orderBy: { revision: "desc" }, take: 1 } } },
      },
    }),
    "order",
  );
  const bill = found(order.bill, "bill");
  const revision = bill.revisions[0]!;
  const snapshot = revision.lines as SnapshotLine[];
  const companyTotals = revision.companyTotals as SnapshotCompany[];

  const [products, companies, tenant, paidAtSale, damages] = await Promise.all([
    ctx.db.product.findMany({
      where: { id: { in: snapshot.map((l) => l.productId) } },
      select: { id: true, code: true, name: true, shortName: true },
    }),
    ctx.db.company.findMany({
      where: { id: { in: companyTotals.map((c) => c.companyId) } },
      select: { id: true, name: true },
    }),
    ctx.db.tenant.findUniqueOrThrow({ where: { id: ctx.user.tenantId } }),
    // Taken with the order (a counter sale's "paid now"); reversed payments do not count.
    ctx.db.customerPayment.findMany({
      where: { salesOrderId: order.id, status: "POSTED" },
      select: { amount: true, method: true },
    }),
    // Damage the customer brought back, deducted from this bill ("− Damage" on a counter sale).
    ctx.db.damageReturn.findMany({
      where: { salesOrderId: order.id, status: "POSTED" },
      select: { number: true, damagedAmount: true },
    }),
  ]);
  const productById = new Map(products.map((p) => [p.id, p]));
  const companyName = new Map(companies.map((c) => [c.id, c.name]));

  // Previous balance: frozen when the bill is posted (dispatch); until then, the live balance
  // (this bill is not in the ledger yet, so the ledger balance is exactly "previous").
  const posted = bill.postedAt !== null;
  const previousTotal = posted
    ? bill.previousBalance
    : (await customerPending(ctx.db, order.customerId)).total;

  const lines = snapshot.map((l) => ({
    ...l,
    code: productById.get(l.productId)?.code ?? "",
    name: productById.get(l.productId)?.name ?? "",
    /** For the compact bill; the name when there is none. */
    shortName: productById.get(l.productId)?.shortName ?? productById.get(l.productId)?.name ?? "",
    companyName: companyName.get(l.companyId) ?? "",
  }));
  const totalDue = previousTotal.add(revision.netAmount);

  return {
    tenant: { name: tenant.name, address: tenant.address, phone: tenant.phone },
    order: {
      id: order.id,
      number: order.number,
      status: order.status,
      deliveryDate: order.deliveryDate,
      orderDate: order.orderDate,
      fulfilment: order.fulfilment,
    },
    customer: {
      name: order.customer.name,
      shopName: order.customer.shopName,
      phone: order.customer.phone,
      address: order.customer.address,
      areaName: order.customer.area?.name ?? null,
    },
    bill: {
      id: bill.id,
      number: bill.number,
      billDate: bill.billDate,
      revision: bill.currentRevision,
      status: bill.status,
      posted,
      grossAmount: D(revision.grossAmount),
      discountAmount: D(revision.discountAmount),
      netAmount: D(revision.netAmount),
      /** Rupees off the whole bill (in `discountAmount`, already off `netAmount`). */
      specialDiscount: companyTotals.reduce((s, c) => s.add(c.specialDiscount ?? 0), D(0)),
    },
    lines,
    previous: previousTotal,
    totalDue,
    /** Paid with the order (a counter sale), and how; the bill shows it and the balance left. */
    paid: {
      amount: paidAtSale.reduce((sum, p) => sum.add(p.amount), D(0)),
      methods: [...new Set(paidAtSale.map((p) => p.method))],
    },
    /** Damage deducted from this bill: comes off the balance due like a payment. */
    damage: {
      amount: damages.reduce((sum, d) => sum.add(d.damagedAmount), D(0)),
      numbers: damages.map((d) => d.number),
    },
    // From the customer's credit limit today, so a reprint follows a changed limit.
    minimumPayment: D(
      minimumPayment({
        previous: previousTotal.toString(),
        // Damage deducted from this bill is owed no more.
        totalDue: totalDue
          .sub(damages.reduce((sum, d) => sum.add(d.damagedAmount), D(0)))
          .toString(),
        creditLimit: order.customer.creditLimit?.toString() ?? null,
      }).toFixed(2),
    ),
  };
}

export type BillView = Awaited<ReturnType<typeof getBillView>>;

export const MAX_BULK_BILLS = 200;

/**
 * Bills of several orders for printing in one go, in the order given. Orders without a bill (or
 * of another tenant) are skipped and counted, so a stale selection never blocks the print run.
 */
export async function getBillViews(ctx: ServiceCtx, orderIds: string[]) {
  assertCan(ctx.user.role, "operations.manage");
  const ids = [...new Set(orderIds)];
  if (ids.length > MAX_BULK_BILLS)
    throw new ServiceError(`Print at most ${MAX_BULK_BILLS} bills at a time.`);
  const views: BillView[] = [];
  let skipped = 0;
  for (const id of ids) {
    try {
      views.push(await getBillView(ctx, id));
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
      skipped++;
    }
  }
  return { views, skipped };
}
