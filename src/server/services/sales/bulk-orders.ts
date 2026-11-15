import "server-only";

import { z, ZodError } from "zod";

import { Prisma } from "@/generated/prisma/client";
import { toDateInput } from "@/lib/dates";
import type { DiscountType } from "@/lib/pricing";
import { dateSchema, idSchema, requestIdSchema } from "@/lib/validation/master";
import { ORDER_SOURCES } from "@/lib/validation/sales";

import { writeAudit } from "../../audit";
import { assertCan } from "../../auth/permissions";
import { ServiceError } from "../errors";
import type { ServiceCtx } from "../master/common";
import { found } from "../posting";
import { savedDiscounts } from "./customer-discounts";
import { createSalesOrder } from "./orders";
import { stockPositions } from "./positions";

// Bulk order entry: a sheet of customers (rows) × products (columns) for one warehouse, as the
// order booker reports it. Each row is booked as one ordinary order through createSalesOrder, so
// pricing, the customer's own discounts, credit checks, audit and idempotency are exactly the
// order screen's. Rows are booked one by one: a row that fails (credit, a deactivated product)
// does not stop the others, and a retried sheet never books a row twice (one requestId per row).

/** At most this many rows are booked in one go (keeps one request well inside the time limit). */
export const MAX_BULK_ROWS = 100;

/** Everything the bulk sheet of a warehouse needs: products, customers, their discounts, layout. */
export async function bulkOrderSheet(ctx: ServiceCtx, warehouseId: string) {
  assertCan(ctx.user.role, "operations.manage");
  const warehouse = found(
    await ctx.db.warehouse.findFirst({ where: { id: warehouseId, isActive: true } }),
    "warehouse",
  );
  const [rows, customers, layout, positions] = await Promise.all([
    ctx.db.product.findMany({
      where: { isActive: true, company: { warehouseId, isActive: true } },
      include: {
        company: { select: { name: true } },
        discountTiers: { orderBy: { minQuantity: "asc" } },
      },
      orderBy: [{ company: { name: "asc" } }, { code: "asc" }],
    }),
    // The warehouse's customers, and customers without an area (served from the chosen warehouse).
    ctx.db.customer.findMany({
      where: { isActive: true, OR: [{ area: { warehouseId } }, { areaId: null }] },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        shopName: true,
        phone: true,
        creditLimit: true,
        isFlagged: true,
        area: { select: { name: true } },
      },
    }),
    ctx.db.bulkOrderLayout.findUnique({
      where: { tenantId_warehouseId: { tenantId: ctx.user.tenantId, warehouseId } },
    }),
    stockPositions(ctx.db, warehouseId),
  ]);
  const productIds = rows.map((p) => p.id);
  const discounts = productIds.length
    ? await ctx.db.customerProductDiscount.findMany({
        where: { productId: { in: productIds }, customer: { isActive: true } },
        select: { customerId: true, productId: true, discountPerDozen: true },
      })
    : [];
  const known = new Set(productIds);
  return {
    warehouse: { id: warehouse.id, name: warehouse.name },
    products: rows.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      shortName: p.shortName,
      companyId: p.companyId,
      companyName: p.company.name,
      saleRate: p.saleRate.toFixed(2),
      discountType: p.discountType as DiscountType,
      discountValue: p.discountValue.toFixed(2),
      tiers: p.discountTiers.map((t) => ({
        minQuantity: t.minQuantity,
        discountType: t.discountType as DiscountType,
        discountValue: t.discountValue.toFixed(2),
      })),
      /** Packets free to sell now (on hand less what booked orders reserve). */
      available: positions.get(p.id)?.available ?? 0,
    })),
    customers: customers.map((c) => ({
      id: c.id,
      name: c.name,
      shopName: c.shopName,
      phone: c.phone,
      areaName: c.area?.name ?? null,
      hasCreditLimit: c.creditLimit !== null,
      isFlagged: c.isFlagged,
    })),
    /** The customers' own discounts per dozen: [customerId, productId, discount]. */
    discounts: discounts.map((d) => [d.customerId, d.productId, d.discountPerDozen.toFixed(2)]),
    /** The saved column order (products since deactivated left out); null = never arranged. */
    columns: layout ? layout.productIds.filter((id) => known.has(id)) : null,
  };
}

export type BulkOrderSheet = Awaited<ReturnType<typeof bulkOrderSheet>>;

const layoutSchema = z.object({
  warehouseId: idSchema,
  productIds: z.array(idSchema).max(1000),
});

/** Saves which products the warehouse's sheet shows, in order (shared by everyone). */
export async function saveBulkOrderLayout(ctx: ServiceCtx, input: unknown) {
  assertCan(ctx.user.role, "operations.manage");
  const data = layoutSchema.parse(input);
  const productIds = [...new Set(data.productIds)];
  return ctx.db.$transaction(async (tx) => {
    found(await tx.warehouse.findUnique({ where: { id: data.warehouseId } }), "warehouse");
    const inWarehouse = await tx.product.count({
      where: { id: { in: productIds }, company: { warehouseId: data.warehouseId } },
    });
    if (inWarehouse !== productIds.length)
      throw new ServiceError("A column is a product from another warehouse.");
    const key = {
      tenantId_warehouseId: { tenantId: ctx.user.tenantId, warehouseId: data.warehouseId },
    };
    const before = await tx.bulkOrderLayout.findUnique({ where: key });
    const saved = await tx.bulkOrderLayout.upsert({
      where: key,
      create: {
        tenantId: ctx.user.tenantId,
        warehouseId: data.warehouseId,
        productIds,
        updatedById: ctx.user.id,
      },
      update: { productIds, updatedById: ctx.user.id },
    });
    await writeAudit(tx, ctx.user, {
      action: before ? "UPDATE" : "CREATE",
      entityType: "BulkOrderLayout",
      entityId: saved.id,
      oldValue: before ? { productIds: before.productIds } : null,
      newValue: { warehouseId: data.warehouseId, productIds },
    });
    return saved.productIds;
  });
}

const bulkRowSchema = z.object({
  /** One per row, made in the browser: a retried sheet returns the order already booked. */
  requestId: requestIdSchema,
  customerId: idSchema,
  lines: z
    .array(z.object({ productId: idSchema, quantity: z.string().max(20) }))
    .min(1, "Enter a quantity for at least one product")
    .max(200),
});

const bulkOrdersSchema = z
  .object({
    warehouseId: idSchema,
    orderDate: dateSchema("order date"),
    deliveryDate: dateSchema("delivery date"),
    source: z.enum(ORDER_SOURCES).default("OFFICE"),
    allowOverCredit: z.boolean().default(false),
    rows: z
      .array(bulkRowSchema)
      .min(1, "Enter at least one customer with a quantity")
      .max(MAX_BULK_ROWS, `Book at most ${MAX_BULK_ROWS} rows at a time`),
  })
  .refine((o) => o.deliveryDate >= o.orderDate, {
    path: ["deliveryDate"],
    message: "Delivery cannot be before the order date",
  });

export type BulkRowResult =
  | {
      requestId: string;
      ok: true;
      orderId: string;
      number: number;
      amount: string;
      needsCreditApproval: boolean;
      /** Products this order is short of (booked anyway, as on the order screen). */
      shortages: string[];
    }
  | { requestId: string; ok: false; error: string };

function rowError(error: unknown): string {
  if (error instanceof ServiceError) return error.message;
  if (error instanceof ZodError) return error.issues[0]?.message ?? "Check this row.";
  // Someone saved related records at the same moment: this row only, safe to book again.
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034")
    return "Someone saved at the same moment. Book again.";
  throw error;
}

/**
 * Books each row of the sheet as one order. A row's lines use the customer's saved discount for
 * that product, so booking from the sheet never changes (or clears) a customer's discounts.
 */
export async function bookBulkOrders(ctx: ServiceCtx, input: unknown): Promise<BulkRowResult[]> {
  assertCan(ctx.user.role, "operations.manage");
  const data = bulkOrdersSchema.parse(input);
  const seen = new Map<string, number>();
  for (const row of data.rows) seen.set(row.customerId, (seen.get(row.customerId) ?? 0) + 1);

  const customers = await ctx.db.customer.findMany({
    where: { id: { in: [...seen.keys()] } },
    select: { id: true, name: true, area: { select: { warehouseId: true } } },
  });
  const byId = new Map(customers.map((c) => [c.id, c]));

  const results: BulkRowResult[] = [];
  for (const row of data.rows) {
    const requestId = row.requestId ?? "";
    const customer = byId.get(row.customerId);
    if (!customer) {
      results.push({ requestId, ok: false, error: "Customer not found." });
      continue;
    }
    if ((seen.get(row.customerId) ?? 0) > 1) {
      results.push({
        requestId,
        ok: false,
        error: `${customer.name} is on the sheet twice. Put their quantities in one row.`,
      });
      continue;
    }
    if (customer.area && customer.area.warehouseId !== data.warehouseId) {
      results.push({
        requestId,
        ok: false,
        error: `${customer.name} is served from another warehouse.`,
      });
      continue;
    }
    try {
      const saved = await savedDiscounts(
        ctx.db,
        customer.id,
        row.lines.map((l) => l.productId),
      );
      const booked = await createSalesOrder(ctx, {
        requestId: row.requestId,
        customerId: customer.id,
        warehouseId: data.warehouseId,
        // As typed (YYYY-MM-DD): createSalesOrder checks the order like any other.
        orderDate: toDateInput(data.orderDate),
        deliveryDate: toDateInput(data.deliveryDate),
        source: data.source,
        allowOverCredit: data.allowOverCredit,
        lines: row.lines.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          discount: saved.get(l.productId)?.toFixed(2) ?? "",
        })),
      });
      results.push({
        requestId,
        ok: true,
        orderId: booked.id,
        number: booked.number,
        amount: booked.credit.thisOrder.toFixed(2),
        needsCreditApproval: booked.needsCreditApproval,
        shortages: booked.shortages.map((s) => s.name),
      });
    } catch (error) {
      results.push({ requestId, ok: false, error: rowError(error) });
    }
  }
  return results;
}
