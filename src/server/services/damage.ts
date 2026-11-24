import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { businessToday } from "@/lib/dates";
import { formatMoney } from "@/lib/format";
import { icontains, matchEveryWord, searchNumber } from "@/lib/list-params";
import type { DiscountType } from "@/lib/pricing";
import { calculateLineAmounts } from "@/lib/pricing";
import { priceLineFor } from "@/lib/sales";
import { PACKETS_PER_DOZEN } from "@/lib/units";
import { damageSchema } from "@/lib/validation/damage";
import { reverseSchema } from "@/lib/validation/purchasing";

import { writeAudit } from "../audit";
import { assertCan } from "../auth/permissions";
import type { TenantTx } from "../db/tenant";
import { ServiceError } from "./errors";
import { PAGE_SIZE, paged, type ServiceCtx } from "./master/common";
import { found, nextDocumentNumber, reverseLedgerFor } from "./posting";
import type { DateRange } from "./purchasing/filters";
import { logClaim } from "./purchasing/claims";
import { savedDiscounts } from "./sales/customer-discounts";
import { assertStockOnHand, stockOut } from "./sales/post-bill";

// Customer damage (the Damage screen): a customer brings back damaged goods and gets other goods
// in exchange, a credit on their account, or both. In one transaction:
//  - the damaged goods go into DAMAGED stock (product's warehouse); replacements leave saleable
//    stock (refused when the warehouse is short);
//  - the customer's account changes by damaged value − replacement value: a credit when positive
//    (it comes off their next bill), a charge when the replacement is worth more;
//  - each damaged line's company gets a claim at the purchase rate, AWAITING settlement with the
//    company (Purchases → Claims), as for damage at day-end.
// Values default to what the customer pays: the sale rate less their own discount (or the
// product's discount and slabs). Cancelled by reversal, never edited.

const D = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v);

const amountOf = (packets: number, rate: Prisma.Decimal) =>
  D(
    calculateLineAmounts({
      quantity: packets,
      baseUnitsPerPriceUnit: PACKETS_PER_DOZEN,
      rate,
    }).netAmount.toString(),
  );

/** What this customer pays per dozen for the product (sale rate less their discount or slabs). */
function paidRate(
  p: {
    id: string;
    companyId: string;
    saleRate: Prisma.Decimal;
    discountType: string;
    discountValue: Prisma.Decimal;
    discountTiers: { minQuantity: number; discountType: string; discountValue: Prisma.Decimal }[];
  },
  packets: number,
  customerDiscount: Prisma.Decimal | null,
) {
  const priced = priceLineFor(
    {
      id: p.id,
      companyId: p.companyId,
      saleRate: p.saleRate.toString(),
      discountType: p.discountType as DiscountType,
      discountValue: p.discountValue.toString(),
      tiers: p.discountTiers.map((t) => ({
        minQuantity: t.minQuantity,
        discountType: t.discountType as DiscountType,
        discountValue: t.discountValue.toString(),
      })),
    },
    packets,
    customerDiscount?.toString() ?? null,
  );
  return D(priced.netAmount.toString()).mul(PACKETS_PER_DOZEN).div(packets).toDecimalPlaces(2);
}

export async function createDamageReturn(ctx: ServiceCtx, input: unknown) {
  assertCan(ctx.user.role, "operations.manage");
  const data = damageSchema.parse(input);
  return ctx.db.$transaction(
    async (tx) => {
      if (data.requestId) {
        const existing = await tx.damageReturn.findUnique({
          where: { tenantId_requestId: { tenantId: ctx.user.tenantId, requestId: data.requestId } },
        });
        if (existing) return existing;
      }
      const customer = await tx.customer.findUnique({ where: { id: data.customerId } });
      if (!customer || !customer.isActive) throw new ServiceError("Choose an active customer.");
      return postDamageReturn(tx, ctx, { ...data, customer });
    },
    // Serializable: like a sale, two at once must not both take the same stock.
    { timeout: 30_000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

type DamageLine = { productId: string; quantity: number; rate: string | null };

/**
 * Prices damage lines at what the customer pays (or the typed rate): used to post an entry, and
 * by a counter sale to know the damage it deducts before the sale is booked.
 */
export async function priceDamage(
  tx: TenantTx,
  customerId: string,
  data: { damaged: DamageLine[]; replacements: DamageLine[] },
) {
  const ids = [...new Set([...data.damaged, ...data.replacements].map((l) => l.productId))];
  const [products, discounts] = await Promise.all([
    tx.product.findMany({
      where: { id: { in: ids } },
      include: {
        discountTiers: true,
        company: { select: { warehouseId: true, name: true } },
      },
    }),
    savedDiscounts(tx, customerId, ids),
  ]);
  const byId = new Map(products.map((p) => [p.id, p]));
  if (byId.size !== ids.length) throw new ServiceError("A product was not found.");

  const priced = (kind: "DAMAGED" | "REPLACEMENT") => (l: (typeof data.damaged)[number]) => {
    const p = byId.get(l.productId)!;
    if (kind === "REPLACEMENT" && !p.isActive)
      throw new ServiceError(`${p.name} is deactivated; give another product.`);
    const rate = l.rate ? D(l.rate) : paidRate(p, l.quantity, discounts.get(p.id) ?? null);
    return { kind, product: p, quantity: l.quantity, rate, amount: amountOf(l.quantity, rate) };
  };
  const damaged = data.damaged.map(priced("DAMAGED"));
  const replacements = data.replacements.map(priced("REPLACEMENT"));
  const damagedAmount = damaged.reduce((s, l) => s.add(l.amount), D(0));
  const replacementAmount = replacements.reduce((s, l) => s.add(l.amount), D(0));
  return { damaged, replacements, damagedAmount, replacementAmount };
}

/**
 * Posts a damage entry inside the caller's transaction: damaged goods into DAMAGED stock,
 * replacements out of saleable stock, the customer's account by damaged − replacement value, and
 * an AWAITING claim per damaged line. `salesOrderId`: the counter sale it is deducted from.
 */
export async function postDamageReturn(
  tx: TenantTx,
  ctx: ServiceCtx,
  data: {
    customer: { id: string; name: string };
    returnDate: Date;
    note: string | null;
    requestId?: string;
    salesOrderId?: string;
    damaged: DamageLine[];
    replacements: DamageLine[];
  },
) {
  const customer = data.customer;
  const { damaged, replacements, damagedAmount, replacementAmount } = await priceDamage(
    tx,
    customer.id,
    data,
  );
  const net = damagedAmount.sub(replacementAmount);

  const entry = await tx.damageReturn.create({
    data: {
      tenantId: ctx.user.tenantId,
      number: await nextDocumentNumber(tx, ctx, "DAMAGE_RETURN"),
      customerId: customer.id,
      salesOrderId: data.salesOrderId ?? null,
      returnDate: data.returnDate,
      damagedAmount,
      replacementAmount,
      note: data.note,
      requestId: data.requestId,
      createdById: ctx.user.id,
      lines: {
        // The tenant comes from the entry (as for an order's lines).
        create: [...damaged, ...replacements].map((l) => ({
          kind: l.kind,
          productId: l.product.id,
          quantity: l.quantity,
          rate: l.rate,
          amount: l.amount,
        })),
      },
    },
  });
  const label = `damage #${entry.number}`;

  // Stock: damaged goods into DAMAGED; replacements out of saleable (refused when short).
  for (const l of damaged) {
    await tx.stockMovement.create({
      data: {
        tenantId: ctx.user.tenantId,
        type: "CUSTOMER_RETURN",
        productId: l.product.id,
        warehouseId: l.product.company.warehouseId,
        bucket: "DAMAGED",
        quantity: l.quantity,
        occurredAt: data.returnDate,
        referenceType: "DamageReturn",
        referenceId: entry.id,
        note: `Damaged, brought back by ${customer.name} (${label})`,
        createdById: ctx.user.id,
      },
    });
  }
  const byWarehouse = new Map<string, typeof replacements>();
  for (const l of replacements)
    byWarehouse.set(l.product.company.warehouseId, [
      ...(byWarehouse.get(l.product.company.warehouseId) ?? []),
      l,
    ]);
  for (const [warehouseId, ls] of byWarehouse) {
    await assertStockOnHand(
      tx,
      warehouseId,
      ls.map((l) => ({
        productId: l.product.id,
        quantity: l.quantity,
        product: { name: l.product.name },
      })),
    );
    const batchLeft = new Map<string, { id: string; available: number }[]>();
    for (const l of ls)
      await stockOut(
        tx,
        ctx,
        {
          productId: l.product.id,
          warehouseId,
          quantity: l.quantity,
          orderId: entry.id,
          at: data.returnDate,
          type: "DAMAGE_REPLACEMENT",
          referenceType: "DamageReturn",
          note: `Given to ${customer.name} for damaged goods (${label})`,
        },
        batchLeft,
      );
  }

  // The customer's account: damaged value − replacements (credit, or a charge when negative).
  if (!net.isZero()) {
    const what = [
      `${damaged.length} damaged item${damaged.length === 1 ? "" : "s"} ${formatMoney(damagedAmount)}`,
      replacements.length ? `given in exchange ${formatMoney(replacementAmount)}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    await tx.ledgerEntry.create({
      data: {
        tenantId: ctx.user.tenantId,
        partyType: "CUSTOMER",
        customerId: customer.id,
        type: net.gt(0) ? "CUSTOMER_RETURN" : "ADJUSTMENT",
        entryDate: data.returnDate,
        ...(net.gt(0) ? { credit: net } : { debit: net.neg() }),
        description: `Damage #${entry.number}: ${what}`,
        referenceType: "DamageReturn",
        referenceId: entry.id,
        createdById: ctx.user.id,
      },
    });
  }

  // Each company is claimed at the purchase rate, waiting for its approval.
  for (const l of damaged) {
    await logClaim(tx, ctx, {
      companyId: l.product.companyId,
      product: { id: l.product.id, name: l.product.name },
      type: "CUSTOMER_DAMAGE",
      claimDate: data.returnDate,
      quantity: l.quantity,
      rate: l.product.purchaseRate,
      amount: amountOf(l.quantity, l.product.purchaseRate),
      note: `${customer.name}, ${label}`,
      damageReturnId: entry.id,
      awaiting: true,
    });
  }

  await writeAudit(tx, ctx.user, {
    action: "POST",
    entityType: "DamageReturn",
    entityId: entry.id,
    newValue: {
      number: entry.number,
      customerId: customer.id,
      returnDate: data.returnDate,
      damaged: damaged.map((l) => ({
        productId: l.product.id,
        quantity: l.quantity,
        rate: l.rate,
      })),
      replacements: replacements.map((l) => ({
        productId: l.product.id,
        quantity: l.quantity,
        rate: l.rate,
      })),
      damagedAmount,
      replacementAmount,
      account: net,
    },
    requestId: data.requestId,
  });
  return entry;
}

/**
 * Cancels a damage entry made by mistake, by reversal: the stock movements are mirrored (refused
 * when the damaged goods were already sent back to the company), the account entry is reversed
 * and its company claims are cancelled (refused once one was deducted on a company bill).
 */
export async function reverseDamageReturn(ctx: ServiceCtx, input: unknown) {
  assertCan(ctx.user.role, "documents.reverse");
  const { id, reason } = reverseSchema.parse(input);
  return ctx.db.$transaction(
    async (tx) => {
      const entry = found(
        await tx.damageReturn.findUnique({
          where: { id },
          include: { claims: true, lines: { include: { product: true } } },
        }),
        "damage entry",
      );
      const applied = entry.claims.find((c) => c.status === "APPLIED");
      if (applied)
        throw new ServiceError(
          `Its claim #${applied.number} was already deducted on a company bill, so this damage cannot be cancelled.`,
        );
      const claimed = await tx.damageReturn.updateMany({
        where: { id, status: "POSTED" },
        data: { status: "REVERSED", reversedAt: new Date(), reversalReason: reason },
      });
      if (claimed.count === 0) throw new ServiceError("This damage entry is already cancelled.");
      const today = businessToday();
      const note = `Damage #${entry.number} cancelled: ${reason}`;

      await reverseStock(tx, ctx, entry.id, today, note);
      await reverseLedgerFor(tx, ctx, { type: "DamageReturn", id }, today, note);
      for (const c of entry.claims.filter(
        (x) => x.status === "AWAITING" || x.status === "PENDING",
      )) {
        await reverseLedgerFor(tx, ctx, { type: "CompanyClaim", id: c.id }, today, note);
        await tx.companyClaim.update({
          where: { id: c.id },
          data: { status: "REVERSED", reversedAt: new Date() },
        });
      }
      await writeAudit(tx, ctx.user, {
        action: "REVERSE",
        entityType: "DamageReturn",
        entityId: id,
        oldValue: { status: "POSTED" },
        newValue: { status: "REVERSED", reason },
      });
    },
    { timeout: 30_000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

async function reverseStock(
  tx: TenantTx,
  ctx: ServiceCtx,
  entryId: string,
  at: Date,
  note: string,
) {
  const moves = await tx.stockMovement.findMany({
    where: { referenceType: "DamageReturn", referenceId: entryId, reversedBy: { none: {} } },
    include: { product: { select: { name: true } } },
  });
  for (const m of moves) {
    // Damaged goods coming back out of DAMAGED stock: they must still be there.
    if (m.quantity > 0) {
      const balance = await tx.stockMovement.aggregate({
        where: { productId: m.productId, warehouseId: m.warehouseId, bucket: m.bucket },
        _sum: { quantity: true },
      });
      if ((balance._sum.quantity ?? 0) < m.quantity)
        throw new ServiceError(
          `${m.product.name}: the damaged stock was already sent back to the company, so this damage cannot be cancelled.`,
        );
    }
    await tx.stockMovement.create({
      data: {
        tenantId: ctx.user.tenantId,
        type: "REVERSAL",
        productId: m.productId,
        warehouseId: m.warehouseId,
        batchId: m.batchId,
        bucket: m.bucket,
        quantity: -m.quantity,
        occurredAt: at,
        referenceType: "DamageReturn",
        referenceId: entryId,
        reversalOfId: m.id,
        note,
        createdById: ctx.user.id,
      },
    });
  }
}

// ───────────────────────── Reading ─────────────────────────

export type DamageFilters = { q?: string; status?: string; page: number } & DateRange;

export async function listDamageReturns(ctx: ServiceCtx, f: DamageFilters) {
  assertCan(ctx.user.role, "operations.manage");
  const number = searchNumber(f.q);
  const where: Prisma.DamageReturnWhereInput = {
    ...(f.status === "REVERSED"
      ? { status: "REVERSED" }
      : f.status === "all"
        ? {}
        : { status: "POSTED" }),
    ...(f.from || f.to
      ? {
          returnDate: {
            ...(f.from ? { gte: f.from } : {}),
            ...(f.to ? { lte: f.to } : {}),
          },
        }
      : {}),
    ...(f.q
      ? {
          OR: [
            ...(number ? [{ number }] : []),
            {
              customer: matchEveryWord(f.q, (w) => [
                { name: icontains(w) },
                { shopName: icontains(w) },
              ]),
            },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    ctx.db.damageReturn.findMany({
      where,
      orderBy: [{ returnDate: "desc" }, { number: "desc" }],
      skip: (f.page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        customer: { select: { name: true, shopName: true } },
        lines: { select: { kind: true, quantity: true } },
      },
    }),
    ctx.db.damageReturn.count({ where }),
  ]);
  return paged(
    rows.map((r) => ({
      ...r,
      damagedQty: r.lines.filter((l) => l.kind === "DAMAGED").reduce((s, l) => s + l.quantity, 0),
      replacementQty: r.lines
        .filter((l) => l.kind === "REPLACEMENT")
        .reduce((s, l) => s + l.quantity, 0),
      account: r.damagedAmount.sub(r.replacementAmount),
    })),
    total,
    f.page,
  );
}

export async function getDamageReturn(ctx: ServiceCtx, id: string) {
  assertCan(ctx.user.role, "operations.manage");
  const entry = found(
    await ctx.db.damageReturn.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, name: true, shopName: true } },
        lines: {
          include: { product: { select: { code: true, name: true } } },
          orderBy: { kind: "asc" },
        },
        claims: {
          include: { company: { select: { name: true } } },
          orderBy: { number: "asc" },
        },
      },
    }),
    "damage entry",
  );
  return {
    ...entry,
    account: entry.damagedAmount.sub(entry.replacementAmount),
    damagedLines: entry.lines.filter((l) => l.kind === "DAMAGED"),
    replacementLines: entry.lines.filter((l) => l.kind === "REPLACEMENT"),
  };
}
