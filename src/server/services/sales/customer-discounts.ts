import "server-only";

import { Prisma } from "@/generated/prisma/client";

import { writeAudit } from "../../audit";
import { assertCan } from "../../auth/permissions";
import type { TenantDb, TenantTx } from "../../db/tenant";
import type { ServiceCtx } from "../master/common";

// A customer's own discount per product (PKR per dozen). Rates are fixed for everyone; only the
// discount differs per customer. It is set from an order or counter sale: a discount typed on a
// line is saved for the customer, clearing it removes it. Each change is in the audit log.

/** The customer's saved discounts, by product (all of them, or only these products). */
export async function savedDiscounts(
  db: TenantDb | TenantTx,
  customerId: string,
  productIds?: string[],
): Promise<Map<string, Prisma.Decimal>> {
  const rows = await db.customerProductDiscount.findMany({
    where: { customerId, ...(productIds ? { productId: { in: productIds } } : {}) },
    select: { productId: true, discountPerDozen: true },
  });
  return new Map(rows.map((r) => [r.productId, r.discountPerDozen]));
}

export type DiscountChange = {
  productId: string;
  /** What the customer had before this order (null = none: the product's discount). */
  before: Prisma.Decimal | null;
  /** What the order says now (null = none). */
  after: Prisma.Decimal | null;
};

const same = (a: Prisma.Decimal | null, b: Prisma.Decimal | null) =>
  a === null || b === null ? a === b : a.eq(b);

/**
 * Saves the discounts an order changed: a new or different discount is stored, a cleared one is
 * removed. Lines whose discount did not change leave the saved one as it is (so editing an older
 * order does not undo a newer change). Returns the changes made.
 */
export async function saveDiscountChanges(
  tx: TenantTx,
  ctx: ServiceCtx,
  customerId: string,
  changes: DiscountChange[],
  orderId: string,
): Promise<DiscountChange[]> {
  const made = changes.filter((c) => !same(c.before, c.after));
  for (const c of made) {
    const where = {
      tenantId_customerId_productId: {
        tenantId: ctx.user.tenantId,
        customerId,
        productId: c.productId,
      },
    };
    const old = await tx.customerProductDiscount.findUnique({ where });
    let entityId = old?.id ?? "";
    if (c.after === null) {
      if (!old) continue;
      await tx.customerProductDiscount.delete({ where });
    } else {
      const saved = await tx.customerProductDiscount.upsert({
        where,
        create: {
          tenantId: ctx.user.tenantId,
          customerId,
          productId: c.productId,
          discountPerDozen: c.after,
          updatedById: ctx.user.id,
        },
        update: { discountPerDozen: c.after, updatedById: ctx.user.id },
      });
      entityId = saved.id;
    }
    await writeAudit(tx, ctx.user, {
      action: !old ? "CREATE" : c.after === null ? "DELETE" : "UPDATE",
      entityType: "CustomerProductDiscount",
      entityId,
      oldValue: old
        ? { customerId, productId: c.productId, discountPerDozen: old.discountPerDozen }
        : null,
      newValue:
        c.after === null
          ? null
          : { customerId, productId: c.productId, discountPerDozen: c.after, orderId },
    });
  }
  return made;
}

/** A customer's saved discounts with each product, for the customer's page. */
export async function listCustomerDiscounts(ctx: ServiceCtx, customerId: string) {
  assertCan(ctx.user.role, "operations.manage");
  const rows = await ctx.db.customerProductDiscount.findMany({
    where: { customerId },
    include: {
      product: {
        select: {
          code: true,
          name: true,
          saleRate: true,
          discountType: true,
          discountValue: true,
          company: { select: { name: true } },
        },
      },
    },
    orderBy: { product: { code: "asc" } },
  });
  return rows.map((r) => ({
    productId: r.productId,
    code: r.product.code,
    name: r.product.name,
    companyName: r.product.company.name,
    saleRate: r.product.saleRate.toFixed(2),
    normalDiscount:
      r.product.discountType === "NONE"
        ? null
        : r.product.discountType === "PERCENT"
          ? `${r.product.discountValue.toFixed(2)}%`
          : r.product.discountValue.toFixed(2),
    discount: r.discountPerDozen.toFixed(2),
    net: r.product.saleRate.sub(r.discountPerDozen).toFixed(2),
    updatedAt: r.updatedAt,
  }));
}
