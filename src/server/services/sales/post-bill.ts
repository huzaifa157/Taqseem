import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { loadByProduct, takeFromBatches } from "@/lib/delivery";
import { formatDozens } from "@/lib/units";

import type { TenantTx } from "../../db/tenant";
import type { ServiceCtx } from "../master/common";
import { batchBalances } from "../posting";
import { customerPending } from "./positions";

// Posting a sale: the stock leaves the warehouse and the bill goes to the customer ledger. Used by
// trip dispatch (delivery/trips.ts) and by counter sales (counter.ts), so both post the same way.

const D = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v);

export type StockShortage = { productId: string; name: string; needed: number; onHand: number };

/**
 * What these lines take beyond the saleable stock on hand. Selling past it is allowed (purchases
 * are sometimes entered late): stock goes below zero until the goods receipt brings it back. The
 * shortages are recorded in the sale's audit entry and shown in red on screen.
 */
export async function stockShortages(
  tx: TenantTx,
  warehouseId: string,
  lines: { productId: string; quantity: number; product: { name: string } }[],
): Promise<StockShortage[]> {
  const load = loadByProduct(lines);
  const onHand = await tx.stockMovement.groupBy({
    by: ["productId"],
    where: { warehouseId, bucket: "SALEABLE", productId: { in: [...load.keys()] } },
    _sum: { quantity: true },
  });
  const have = new Map(onHand.map((g) => [g.productId, g._sum.quantity ?? 0]));
  const names = new Map(lines.map((l) => [l.productId, l.product.name]));
  return [...load]
    .filter(([pid, qty]) => qty > (have.get(pid) ?? 0))
    .map(([pid, qty]) => ({
      productId: pid,
      name: names.get(pid)!,
      needed: qty,
      onHand: have.get(pid) ?? 0,
    }));
}

/** For an audit entry: "Chips: needed 5 dz, 2 dz on hand". */
export const shortageNotes = (short: StockShortage[]) =>
  short.map(
    (s) => `${s.name}: needed ${formatDozens(s.needed)}, ${formatDozens(s.onHand)} on hand`,
  );

/** Saleable stock movements out of the warehouse for one line, oldest batches first. */
export async function stockOut(
  tx: TenantTx,
  ctx: ServiceCtx,
  m: {
    productId: string;
    warehouseId: string;
    quantity: number;
    orderId: string;
    at: Date;
    /** Default: a sale (DISPATCH of a SalesOrder). */
    type?: "DISPATCH" | "DAMAGE_REPLACEMENT";
    referenceType?: string;
    note?: string;
  },
  batchLeft: Map<string, { id: string; available: number }[]>,
) {
  let batches = batchLeft.get(m.productId);
  if (!batches) {
    const rows = await tx.batch.findMany({
      where: { productId: m.productId, warehouseId: m.warehouseId },
      orderBy: [{ receivedDate: "asc" }, { createdAt: "asc" }],
      select: { id: true },
    });
    const balances = await batchBalances(
      tx,
      rows.map((r) => r.id),
    );
    batches = rows.map((r) => ({ id: r.id, available: balances.get(r.id) ?? 0 }));
    batchLeft.set(m.productId, batches);
  }
  const { slices, unbatched } = takeFromBatches(m.quantity, batches);
  for (const s of slices) batches.find((b) => b.id === s.batchId)!.available -= s.quantity;
  const parts: { batchId: string | null; quantity: number }[] = [
    ...slices,
    ...(unbatched > 0 ? [{ batchId: null, quantity: unbatched }] : []),
  ];
  for (const part of parts) {
    await tx.stockMovement.create({
      data: {
        tenantId: ctx.user.tenantId,
        type: m.type ?? "DISPATCH",
        productId: m.productId,
        warehouseId: m.warehouseId,
        batchId: part.batchId,
        bucket: "SALEABLE",
        quantity: -part.quantity,
        occurredAt: m.at,
        referenceType: m.referenceType ?? "SalesOrder",
        referenceId: m.orderId,
        note: m.note ?? null,
        createdById: ctx.user.id,
      },
    });
  }
}

/**
 * Posts an order's bill to the customer ledger (one entry: customers have one account) dated
 * `date`, and freezes the customer's previous balance for printing.
 */
export async function postOrderBill(
  tx: TenantTx,
  ctx: ServiceCtx,
  order: {
    id: string;
    number: number;
    customerId: string;
    lines: { netAmount: Prisma.Decimal }[];
    /** Rupees off the whole bill. */
    specialDiscount: Prisma.Decimal;
    bill: { id: string; number: number } | null;
  },
  date: Date,
) {
  const bill = order.bill!;
  const pending = await customerPending(tx, order.customerId);
  await tx.bill.update({
    where: { id: bill.id },
    data: { postedAt: new Date(), billDate: date, previousBalance: pending.total },
  });
  const lines = order.lines.reduce((s, l) => s.add(l.netAmount), D(0));
  const amount = Prisma.Decimal.max(lines.sub(Prisma.Decimal.min(order.specialDiscount, lines)), 0);
  if (amount.isZero()) return;
  await tx.ledgerEntry.create({
    data: {
      tenantId: ctx.user.tenantId,
      partyType: "CUSTOMER",
      customerId: order.customerId,
      type: "SALES_BILL",
      entryDate: date,
      debit: amount,
      description: `Bill #${bill.number} (order #${order.number})`,
      referenceType: "Bill",
      referenceId: bill.id,
      createdById: ctx.user.id,
    },
  });
}
