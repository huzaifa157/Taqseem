import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../../db/client";
import { createTenantDb } from "../../db/tenant";
import { createArea } from "../master/areas";
import type { ServiceCtx } from "../master/common";
import { createCompany } from "../master/companies";
import { createCustomer } from "../master/customers";
import { createProduct } from "../master/products";
import { createWarehouse } from "../master/warehouses";
import { createGoodsReceipt } from "../purchasing/goods-receipts";
import { bookBulkOrders, bulkOrderSheet, saveBulkOrderLayout } from "./bulk-orders";
import { savedDiscounts } from "./customer-discounts";
import { getSalesOrder } from "./orders";

async function setup() {
  const suffix = randomUUID().slice(0, 8);
  const tenant = await prisma.tenant.create({ data: { name: `B ${suffix}`, slug: `b-${suffix}` } });
  const owner = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `b-${suffix}@t.local`,
      name: "Owner",
      role: "OWNER",
      passwordHash: "x",
    },
  });
  const ctx: ServiceCtx = {
    db: createTenantDb(tenant.id),
    user: { id: owner.id, role: "OWNER", tenantId: tenant.id },
  };
  const staff: ServiceCtx = { ...ctx, user: { ...ctx.user, role: "STAFF" } };
  const main = await createWarehouse(ctx, { name: "Main" });
  const other = await createWarehouse(ctx, { name: "Other" });
  const area = await createArea(ctx, { warehouseId: main.id, name: "Shahdara" });
  const farArea = await createArea(ctx, { warehouseId: other.id, name: "Far town" });
  const company = (warehouseId: string, name: string) =>
    createCompany(ctx, { warehouseId, name, paymentTermsDays: "15", openingBalance: "" });
  const crunchy = await company(main.id, "Crunchy");
  const golden = await company(main.id, "Golden");
  const faraway = await company(other.id, "Faraway");
  const product = (companyId: string, code: string, saleRate: string, extra: object = {}) =>
    createProduct(ctx, {
      companyId,
      code,
      name: `Item ${code}`,
      purchaseRate: "100",
      saleRate,
      effectiveFrom: "2026-10-01",
      ...extra,
    });
  const chips = await product(crunchy.id, "CB01", "228", {
    shortName: "Chips",
    discountType: "AMOUNT_PER_UNIT",
    discountValue: "4",
    slabs: [{ fromDozens: "25", value: "8" }],
  });
  const nimko = await product(golden.id, "GC01", "230");
  const far = await product(faraway.id, "FA01", "100");
  await createGoodsReceipt(ctx, {
    companyId: crunchy.id,
    receivedDate: "2026-10-01",
    lines: [{ productId: chips.id, quantity: "30" }],
  });
  await createGoodsReceipt(ctx, {
    companyId: golden.id,
    receivedDate: "2026-10-01",
    lines: [{ productId: nimko.id, quantity: "10" }],
  });
  const ali = await createCustomer(ctx, {
    name: "Ali Khan",
    type: "RETAILER",
    areaId: area.id,
    creditLimit: "10000",
    openingBalances: { [crunchy.id]: "3000", [golden.id]: "1000" },
  });
  const bilal = await createCustomer(ctx, {
    name: "Bilal Store",
    type: "RETAILER",
    areaId: area.id,
  });
  const noArea = await createCustomer(ctx, { name: "Walk-in Wali", type: "RETAILER" });
  const farCustomer = await createCustomer(ctx, {
    name: "Far Customer",
    type: "RETAILER",
    areaId: farArea.id,
  });
  // Bilal's own discount on chips: Rs 20 a dozen.
  await ctx.db.customerProductDiscount.create({
    data: {
      tenantId: tenant.id,
      customerId: bilal.id,
      productId: chips.id,
      discountPerDozen: "20",
    },
  });
  return { ctx, staff, main, other, chips, nimko, far, ali, bilal, noArea, farCustomer };
}

let t: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  t = await setup();
});

const sheet = (rows: object[], extra: object = {}) => ({
  warehouseId: t.main.id,
  orderDate: "2026-10-24",
  deliveryDate: "2026-10-25",
  rows,
  ...extra,
});
const row = (customerId: string, lines: [string, string][], requestId = randomUUID()) => ({
  requestId,
  customerId,
  lines: lines.map(([productId, quantity]) => ({ productId, quantity })),
});

describe("the bulk order sheet", () => {
  it("lists the warehouse's products, its customers (and those without an area), and their discounts", async () => {
    const s = await bulkOrderSheet(t.staff, t.main.id);
    expect(s.products.map((p) => [p.code, p.shortName, p.companyName, p.available])).toEqual([
      ["CB01", "Chips", "Crunchy", 360],
      ["GC01", null, "Golden", 120],
    ]);
    expect(s.customers.map((c) => c.name)).toEqual(["Ali Khan", "Bilal Store", "Walk-in Wali"]);
    expect(s.discounts).toEqual([[t.bilal.id, t.chips.id, "20.00"]]);
    expect(s.columns).toBeNull();
  });

  it("keeps one shared column order per warehouse, and refuses another warehouse's product", async () => {
    await saveBulkOrderLayout(t.staff, { warehouseId: t.main.id, productIds: [t.nimko.id] });
    await saveBulkOrderLayout(t.ctx, {
      warehouseId: t.main.id,
      productIds: [t.nimko.id, t.chips.id],
    });
    expect((await bulkOrderSheet(t.ctx, t.main.id)).columns).toEqual([t.nimko.id, t.chips.id]);
    expect(await t.ctx.db.auditLog.count({ where: { entityType: "BulkOrderLayout" } })).toBe(2);
    await expect(
      saveBulkOrderLayout(t.ctx, { warehouseId: t.main.id, productIds: [t.far.id] }),
    ).rejects.toThrow("another warehouse");
  });
});

describe("booking the sheet", () => {
  it("books one order per row at the fixed rates, with each customer's own discount kept", async () => {
    const results = await bookBulkOrders(
      t.staff,
      sheet([
        row(t.ali.id, [
          [t.chips.id, "2"],
          [t.nimko.id, "1"],
        ]),
        row(t.bilal.id, [[t.chips.id, "1.5"]]),
      ]),
    );
    expect(results.map((r) => (r.ok ? r.amount : r.error))).toEqual([
      "678.00", // 2 × (228 − 4) + 230
      "312.00", // 1.5 × (228 − 20): Bilal's own discount
    ]);
    const bilalOrder = results[1]!;
    if (!bilalOrder.ok) throw new Error("not booked");
    const full = await getSalesOrder(t.ctx, bilalOrder.orderId);
    expect(full.lines.map((l) => [l.quantity, l.customerDiscount])).toEqual([[18, true]]);
    expect(full.deliveryDate.toISOString().slice(0, 10)).toBe("2026-10-25");
    // Booking from the sheet leaves the saved discounts as they were.
    expect((await savedDiscounts(t.ctx.db, t.bilal.id)).get(t.chips.id)?.toFixed(2)).toBe("20.00");
    expect(await savedDiscounts(t.ctx.db, t.ali.id)).toEqual(new Map());
  });

  it("reports a row's problem on that row and books the others", async () => {
    const results = await bookBulkOrders(
      t.staff,
      sheet([
        row(t.ali.id, [[t.chips.id, "1"]]),
        row(t.bilal.id, [[t.chips.id, "1"]]),
        row(t.bilal.id, [[t.nimko.id, "1"]]),
        row(t.farCustomer.id, [[t.chips.id, "1"]]),
        row(t.noArea.id, [[t.chips.id, "1.25"]]),
      ]),
    );
    expect(results.map((r) => (r.ok ? "booked" : r.error))).toEqual([
      "booked",
      "Bilal Store is on the sheet twice. Put their quantities in one row.",
      "Bilal Store is on the sheet twice. Put their quantities in one row.",
      "Far Customer is served from another warehouse.",
      expect.stringMatching(/half dozens|whole or half/i),
    ]);
    expect(await t.ctx.db.salesOrder.count()).toBe(1);
  });

  it("never books a row twice when the same sheet is sent again", async () => {
    const rows = [row(t.ali.id, [[t.chips.id, "1"]]), row(t.bilal.id, [[t.nimko.id, "2"]])];
    const first = await bookBulkOrders(t.staff, sheet(rows));
    const again = await bookBulkOrders(t.staff, sheet(rows));
    expect(again.map((r) => r.ok && r.number)).toEqual(first.map((r) => r.ok && r.number));
    expect(await t.ctx.db.salesOrder.count()).toBe(2);
  });

  it("follows the credit rules and reports shortages, as the order screen does", async () => {
    // Ali owes 4,000 with a 10,000 limit; 30 dz of chips at the 25 dz slab is 6,600.
    const big = () => row(t.ali.id, [[t.chips.id, "30"]]);
    const [staffRow] = await bookBulkOrders(t.staff, sheet([big()]));
    expect(staffRow).toMatchObject({ ok: true, needsCreditApproval: true });
    const [ownerRow] = await bookBulkOrders(t.ctx, sheet([big()]));
    expect(ownerRow).toMatchObject({ ok: false, error: expect.stringContaining("credit limit") });
    const [allowed] = await bookBulkOrders(t.ctx, sheet([big()], { allowOverCredit: true }));
    expect(allowed).toMatchObject({ ok: true, needsCreditApproval: false });

    const [short] = await bookBulkOrders(t.staff, sheet([row(t.bilal.id, [[t.nimko.id, "12"]])]));
    expect(short).toMatchObject({ ok: true, shortages: ["Item GC01"] });
  });

  it("checks the sheet itself: dates, rows and the row limit", async () => {
    await expect(
      bookBulkOrders(
        t.staff,
        sheet([row(t.ali.id, [[t.chips.id, "1"]])], {
          deliveryDate: "2026-10-20",
        }),
      ),
    ).rejects.toThrow("Delivery cannot be before the order date");
    await expect(bookBulkOrders(t.staff, sheet([]))).rejects.toThrow("at least one customer");
  });
});
