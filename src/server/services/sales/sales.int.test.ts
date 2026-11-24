import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { ForbiddenError } from "../../auth/permissions";
import { prisma } from "../../db/client";
import { createTenantDb } from "../../db/tenant";
import { createArea } from "../master/areas";
import type { ServiceCtx } from "../master/common";
import { createCompany } from "../master/companies";
import { createCustomer } from "../master/customers";
import { createProduct, updateProduct } from "../master/products";
import { createWarehouse } from "../master/warehouses";
import { createGoodsReceipt } from "../purchasing/goods-receipts";
import { salesPerCompany } from "../dashboard-charts";
import { globalSearch } from "../search";
import { getBillView } from "./bills";
import {
  approveCreditOverride,
  cancelSalesOrder,
  createSalesOrder,
  listSalesOrders,
  getSalesOrder,
  orderEntryContext,
  updateSalesOrder,
} from "./orders";
import { stockPositions } from "./positions";

async function setup() {
  const suffix = randomUUID().slice(0, 8);
  const tenant = await prisma.tenant.create({ data: { name: `S ${suffix}`, slug: `s-${suffix}` } });
  const owner = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `s-${suffix}@t.local`,
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
  const crunchy = await createCompany(ctx, {
    warehouseId: main.id,
    name: "Crunchy",
    paymentTermsDays: "15",
    openingBalance: "",
  });
  const golden = await createCompany(ctx, {
    warehouseId: main.id,
    name: "Golden",
    paymentTermsDays: "30",
    openingBalance: "",
  });
  const faraway = await createCompany(ctx, {
    warehouseId: other.id,
    name: "Faraway",
    paymentTermsDays: "7",
    openingBalance: "",
  });
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
  const customer = await createCustomer(ctx, {
    name: "Ali Khan",
    type: "RETAILER",
    areaId: area.id,
    creditLimit: "10000",
    openingBalance: "4000",
  });
  return { ctx, staff, main, other, crunchy, golden, chips, nimko, far, customer };
}

let t: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  t = await setup();
});

const order = (
  lines: { productId: string; quantity: string; discount?: string }[],
  extra: object = {},
) => ({
  customerId: t.customer.id,
  orderDate: "2026-10-24",
  deliveryDate: "2026-10-25",
  lines,
  ...extra,
});

describe("booking an order", () => {
  it("prices lines with the company discount, keeps the company on each line, and creates the bill", async () => {
    const result = await createSalesOrder(
      t.staff,
      order([
        { productId: t.chips.id, quantity: "3.5" },
        { productId: t.nimko.id, quantity: "2" },
      ]),
    );
    const full = await getSalesOrder(t.ctx, result.id);
    const chipsLine = full.lines.find((l) => l.productId === t.chips.id)!;
    expect(chipsLine).toMatchObject({ companyId: t.crunchy.id, quantity: 42 });
    expect([chipsLine.discountAmount.toFixed(2), chipsLine.netAmount.toFixed(2)]).toEqual([
      "14.00",
      "784.00",
    ]);
    expect(full.bill!.netAmount.toFixed(2)).toBe("1244.00"); // 784 + 460
    expect(full.bill!.revisions.map((r) => [r.revision, r.reason])).toEqual([[1, "Booked"]]);
    expect(full.bill!.postedAt).toBeNull();
    // Nothing is posted to the journals at booking.
    expect(await t.ctx.db.ledgerEntry.count({ where: { type: "SALES_BILL" } })).toBe(0);
  });

  it("uses the slab once a line reaches it", async () => {
    const r = await createSalesOrder(t.staff, order([{ productId: t.chips.id, quantity: "25" }]));
    const line = (await getSalesOrder(t.ctx, r.id)).lines[0]!;
    expect([line.discountValue.toFixed(2), line.netAmount.toFixed(2)]).toEqual(["8.00", "5500.00"]);
  });

  it("reserves stock: available drops, editing does not double count, cancelling frees it", async () => {
    const before = (await stockPositions(t.ctx.db, t.main.id)).get(t.chips.id)!;
    expect(before).toEqual({ onHand: 360, reserved: 0, available: 360 });
    const r = await createSalesOrder(t.staff, order([{ productId: t.chips.id, quantity: "5" }]));
    expect((await stockPositions(t.ctx.db, t.main.id)).get(t.chips.id)).toEqual({
      onHand: 360,
      reserved: 60,
      available: 300,
    });
    const ctxForEdit = await orderEntryContext(t.ctx, t.customer.id, { excludeOrderId: r.id });
    expect(ctxForEdit.products.find((p) => p.id === t.chips.id)!.available).toBe(360);
    await updateSalesOrder(t.staff, r.id, order([{ productId: t.chips.id, quantity: "6" }]));
    expect((await stockPositions(t.ctx.db, t.main.id)).get(t.chips.id)!.reserved).toBe(72);
    await cancelSalesOrder(t.staff, { id: r.id });
    expect((await stockPositions(t.ctx.db, t.main.id)).get(t.chips.id)!.reserved).toBe(0);
  });

  it("reports products booked beyond available stock (and still books them)", async () => {
    const r = await createSalesOrder(t.staff, order([{ productId: t.nimko.id, quantity: "12" }]));
    expect(r.shortages).toEqual([{ productId: t.nimko.id, name: "Item GC01", short: 24 }]);
  });

  it("refuses products from another warehouse and requires a warehouse for customers without an area", async () => {
    await expect(
      createSalesOrder(t.staff, order([{ productId: t.far.id, quantity: "1" }])),
    ).rejects.toThrow("not stocked in the customer's warehouse");
    const noArea = await createCustomer(t.ctx, { name: "Walk-in", type: "RETAILER" });
    await expect(
      createSalesOrder(t.staff, {
        ...order([{ productId: t.chips.id, quantity: "1" }]),
        customerId: noArea.id,
      }),
    ).rejects.toThrow("Choose the warehouse");
    const ok = await createSalesOrder(t.staff, {
      ...order([{ productId: t.chips.id, quantity: "1" }]),
      customerId: noArea.id,
      warehouseId: t.main.id,
    });
    expect(ok.number).toBeGreaterThan(0);
  });

  it("is idempotent per request id", async () => {
    const requestId = randomUUID();
    const a = await createSalesOrder(
      t.staff,
      order([{ productId: t.chips.id, quantity: "1" }], { requestId }),
    );
    const b = await createSalesOrder(
      t.staff,
      order([{ productId: t.chips.id, quantity: "1" }], { requestId }),
    );
    expect(b.id).toBe(a.id);
    expect(await t.ctx.db.salesOrder.count()).toBe(1);
  });
});

describe("new customer typed on the order", () => {
  const newOrder = (extra: object) =>
    createSalesOrder(t.staff, {
      orderDate: "2026-10-24",
      deliveryDate: "2026-10-25",
      lines: [{ productId: t.chips.id, quantity: "1" }],
      ...extra,
    });

  it("creates the customer from name and phone (+92), and reuses them by phone", async () => {
    const area = await t.ctx.db.area.findFirstOrThrow();
    const r = await newOrder({
      newCustomerName: "Naveed Traders",
      newCustomerPhone: "0300-5556667",
      newCustomerAreaId: area.id,
    });
    const order = await getSalesOrder(t.ctx, r.id);
    const created = await t.ctx.db.customer.findUniqueOrThrow({ where: { id: order.customerId } });
    expect(created).toMatchObject({
      name: "Naveed Traders",
      phone: "+92 3005556667",
      whatsapp: "+92 3005556667",
      type: "RETAILER",
      areaId: area.id,
    });
    expect(
      await t.ctx.db.auditLog.count({ where: { entityType: "Customer", entityId: created.id } }),
    ).toBe(1);

    // The same phone typed another way is the same customer, not a second one.
    const again = await newOrder({
      newCustomerName: "Naveed",
      newCustomerPhone: "+92 300 5556667",
      newCustomerAreaId: area.id,
    });
    expect((await getSalesOrder(t.ctx, again.id)).customerId).toBe(created.id);
    expect(await t.ctx.db.customer.count({ where: { phone: "+92 3005556667" } })).toBe(1);

    // Found by phone the way it is usually typed.
    const list = await listSalesOrders(t.ctx, { page: 1, q: "0300-555" });
    expect(list.total).toBe(2);
  });

  it("needs a name (the phone is optional), and reuses a customer by name in any capitals", async () => {
    const area = await t.ctx.db.area.findFirstOrThrow();
    const r = await newOrder({ newCustomerName: "Walk-in  Rafiq", newCustomerAreaId: area.id });
    const created = await t.ctx.db.customer.findUniqueOrThrow({
      where: { id: (await getSalesOrder(t.ctx, r.id)).customerId },
    });
    expect(created).toMatchObject({ name: "Walk-in Rafiq", phone: null, whatsapp: null });

    const again = await newOrder({ newCustomerName: "WALK-IN rafiq", newCustomerAreaId: area.id });
    expect((await getSalesOrder(t.ctx, again.id)).customerId).toBe(created.id);
    expect(
      await t.ctx.db.customer.count({
        where: { name: { contains: "rafiq", mode: "insensitive" } },
      }),
    ).toBe(1);
  });

  it("needs a name, and an area for a delivery", async () => {
    await expect(newOrder({ newCustomerPhone: "03001112222" })).rejects.toThrow(/name/);
    await expect(
      newOrder({ newCustomerName: "X", newCustomerPhone: "+44 20 7946 0958" }),
    ).rejects.toThrow(/Pakistani number/);
    await expect(
      newOrder({ newCustomerName: "X", newCustomerPhone: "03001112222" }),
    ).rejects.toThrow(/area/);
    expect(await t.ctx.db.customer.count({ where: { phone: "+92 3001112222" } })).toBe(0);
  });
});

describe("customer's own discount", () => {
  const chipsDiscount = async () =>
    (await orderEntryContext(t.ctx, t.customer.id)).products.find((p) => p.id === t.chips.id)!
      .customerDiscount;
  const audits = () =>
    t.ctx.db.auditLog.findMany({
      where: { entityType: "CustomerProductDiscount" },
      orderBy: { createdAt: "asc" },
      select: { action: true },
    });

  it("keeps the fixed rate, replaces the product's discount, and is saved for the customer", async () => {
    // Chips 228 / dz with 4 off (8 from 25 dz); the customer gets 20 off.
    const r = await createSalesOrder(
      t.staff,
      order([
        { productId: t.chips.id, quantity: "5", discount: "20" },
        { productId: t.nimko.id, quantity: "2" },
      ]),
    );
    const full = await getSalesOrder(t.ctx, r.id);
    const chips = full.lines.find((l) => l.productId === t.chips.id)!;
    expect([
      chips.rate.toFixed(2),
      chips.discountType,
      chips.discountValue.toFixed(2),
      chips.netAmount.toFixed(2),
      chips.customerDiscount,
      chips.standardRate,
    ]).toEqual(["228.00", "AMOUNT_PER_UNIT", "20.00", "1040.00", true, null]);
    expect(full.lines.find((l) => l.productId === t.nimko.id)!.customerDiscount).toBe(false);
    expect(full.bill!.netAmount.toFixed(2)).toBe("1500.00"); // 1040 + 460

    // Saved for the customer: the next order starts with it (the nimko has none).
    expect(await chipsDiscount()).toBe("20.00");
    const entry = await orderEntryContext(t.ctx, t.customer.id);
    expect(entry.products.find((p) => p.id === t.nimko.id)!.customerDiscount).toBeNull();
    expect(await audits()).toEqual([{ action: "CREATE" }]);

    // The same discount again changes nothing; a new one is saved; clearing it removes it.
    await createSalesOrder(
      t.staff,
      order([{ productId: t.chips.id, quantity: "1", discount: "20" }]),
    );
    expect(await audits()).toHaveLength(1);
    await createSalesOrder(
      t.staff,
      order([{ productId: t.chips.id, quantity: "1", discount: "25" }]),
    );
    expect(await chipsDiscount()).toBe("25.00");
    const plain = await createSalesOrder(
      t.staff,
      order([{ productId: t.chips.id, quantity: "1" }]),
    );
    expect((await getSalesOrder(t.ctx, plain.id)).bill!.netAmount.toFixed(2)).toBe("224.00");
    expect(await chipsDiscount()).toBeNull();
    expect((await audits()).map((a) => a.action)).toEqual(["CREATE", "UPDATE", "DELETE"]);

    // Orders with a customer's discount can be listed.
    const list = await listSalesOrders(t.ctx, { page: 1, specialRate: true });
    expect(list.rows).toHaveLength(3);
  });

  it("replaces the quantity slab too, and a zero discount means none at all", async () => {
    const r = await createSalesOrder(
      t.staff,
      order([{ productId: t.chips.id, quantity: "25", discount: "0" }]), // the slab would be 8
    );
    expect((await getSalesOrder(t.ctx, r.id)).bill!.netAmount.toFixed(2)).toBe("5700.00"); // 25 × 228
    expect(await chipsDiscount()).toBe("0.00");
  });

  it("editing an older order does not undo a newer change, unless its discount is changed", async () => {
    const older = await createSalesOrder(
      t.staff,
      order([{ productId: t.chips.id, quantity: "1", discount: "20" }]),
    );
    await createSalesOrder(
      t.staff,
      order([{ productId: t.chips.id, quantity: "1", discount: "30" }]),
    );
    // Only the quantity changes on the older order: the customer keeps 30.
    await updateSalesOrder(
      t.staff,
      older.id,
      order([{ productId: t.chips.id, quantity: "2", discount: "20" }]),
    );
    expect(await chipsDiscount()).toBe("30.00");
    // Its discount changed: that is the customer's now.
    await updateSalesOrder(
      t.staff,
      older.id,
      order([{ productId: t.chips.id, quantity: "2", discount: "15" }]),
    );
    expect(await chipsDiscount()).toBe("15.00");
  });

  it("an older order with a changed rate is re-priced at the fixed rate when edited", async () => {
    const r = await createSalesOrder(t.staff, order([{ productId: t.chips.id, quantity: "5" }]));
    // As saved before discounts per customer: a changed rate of 200 with no discount.
    await t.ctx.db.salesOrderLine.updateMany({
      where: { salesOrderId: r.id },
      data: {
        rate: "200",
        standardRate: "228",
        rateNote: "old",
        discountType: "NONE",
        discountValue: "0",
      },
    });
    expect((await getSalesOrder(t.ctx, r.id)).lines[0]!.standardRate?.toFixed(2)).toBe("228.00");
    await updateSalesOrder(t.staff, r.id, order([{ productId: t.chips.id, quantity: "5" }]));
    const line = (await getSalesOrder(t.ctx, r.id)).lines[0]!;
    expect([line.rate.toFixed(2), line.standardRate, line.netAmount.toFixed(2)]).toEqual([
      "228.00",
      null,
      "1120.00", // 5 × (228 − 4)
    ]);
  });

  it("refuses a discount above the rate", async () => {
    await expect(
      createSalesOrder(t.staff, order([{ productId: t.chips.id, quantity: "1", discount: "229" }])),
    ).rejects.toThrow(/cannot be more than the rate/);
    expect(await chipsDiscount()).toBeNull();
  });
});

describe("credit limit", () => {
  // Limit 10,000; pending 4,000 (opening balances).
  const big = () => order([{ productId: t.chips.id, quantity: "30" }]); // 30 dz × (228 − 8) = 6,600

  it("staff can book past the limit, but the order waits for the owner", async () => {
    await createSalesOrder(t.staff, order([{ productId: t.nimko.id, quantity: "2" }])); // 460 open
    const r = await createSalesOrder(t.staff, big());
    expect(r.credit.over?.toFixed(2)).toBe("1060.00"); // 4000 + 460 + 6600 − 10000
    expect(r.needsCreditApproval).toBe(true);
    await expect(approveCreditOverride(t.staff, { id: r.id })).rejects.toThrow(ForbiddenError);
    await approveCreditOverride(t.ctx, { id: r.id });
    const approved = await getSalesOrder(t.ctx, r.id);
    expect([approved.needsCreditApproval, approved.creditOverrideById]).toEqual([
      false,
      t.ctx.user.id,
    ]);
  });

  it("the owner must tick 'allow' to book past the limit", async () => {
    await createSalesOrder(t.staff, order([{ productId: t.nimko.id, quantity: "2" }]));
    await expect(createSalesOrder(t.ctx, big())).rejects.toThrow("past their credit limit");
    const r = await createSalesOrder(t.ctx, { ...big(), allowOverCredit: "on" });
    expect([r.needsCreditApproval, (await getSalesOrder(t.ctx, r.id)).creditOverrideById]).toEqual([
      false,
      t.ctx.user.id,
    ]);
  });
});

describe("editing and bill revisions", () => {
  it("each edit adds a bill revision; dispatched orders cannot be edited or cancelled", async () => {
    const r = await createSalesOrder(t.staff, order([{ productId: t.chips.id, quantity: "2" }]));
    await updateSalesOrder(
      t.staff,
      r.id,
      order([
        { productId: t.chips.id, quantity: "3" },
        { productId: t.nimko.id, quantity: "1" },
      ]),
    );
    const full = await getSalesOrder(t.ctx, r.id);
    expect(full.bill!.revisions.map((v) => [v.revision, v.netAmount.toFixed(2)])).toEqual([
      [2, "902.00"], // 3 × 224 + 230
      [1, "448.00"],
    ]);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: r.id, action: "UPDATE" },
    });
    expect(audit.oldValue).toMatchObject({ lines: [{ quantity: 24 }] });

    await prisma.salesOrder.update({ where: { id: r.id }, data: { status: "DISPATCHED" } });
    await expect(
      updateSalesOrder(t.staff, r.id, order([{ productId: t.chips.id, quantity: "1" }])),
    ).rejects.toThrow("day-end");
    await expect(cancelSalesOrder(t.staff, { id: r.id })).rejects.toThrow("Only booked or planned");
  });
});

describe("bill view", () => {
  it("shows previous pending, this bill and total due, overall and per company", async () => {
    const r = await createSalesOrder(
      t.staff,
      order([
        { productId: t.chips.id, quantity: "2" },
        { productId: t.nimko.id, quantity: "1" },
      ]),
    );
    const view = await getBillView(t.ctx, r.id);
    expect([
      view.previous.toFixed(2),
      view.bill.netAmount.toFixed(2),
      view.totalDue.toFixed(2),
    ]).toEqual(["4000.00", "678.00", "4678.00"]);
    expect(view.lines.map((l) => l.code).sort()).toEqual(["CB01", "GC01"]);
    // No credit limit: the minimum is what was left over from before.
    expect(view.minimumPayment.toFixed(2)).toBe("4000.00");

    // A 4,500 limit: 4,678 due, so at least the earlier 4,000 (more than the 178 over).
    await prisma.customer.update({ where: { id: t.customer.id }, data: { creditLimit: 4500 } });
    expect((await getBillView(t.ctx, r.id)).minimumPayment.toFixed(2)).toBe("4000.00");
    // A 500 limit: 4,178 over it, which is more than the earlier balance.
    await prisma.customer.update({ where: { id: t.customer.id }, data: { creditLimit: 500 } });
    expect((await getBillView(t.ctx, r.id)).minimumPayment.toFixed(2)).toBe("4178.00");
  });
});

describe("order entry context", () => {
  it("gives what the customer owes, open orders, products with stock, and the last order", async () => {
    await createSalesOrder(t.staff, order([{ productId: t.chips.id, quantity: "2" }]));
    const c = await orderEntryContext(t.ctx, t.customer.id);
    expect([c.pending, c.openOrders, c.customer.creditLimit]).toEqual([
      "4000.00",
      "448.00",
      "10000.00",
    ]);
    expect(c.products.map((p) => p.code)).toEqual(["CB01", "GC01"]);
    expect(c.products[0]).toMatchObject({ available: 336, tiers: [{ minQuantity: 300 }] });
    expect(c.lastOrder?.lines).toEqual([{ productId: t.chips.id, quantity: 24 }]);
  });
});

describe("finding orders", () => {
  it("by customer words in any order, by product code or name, and with the area filter", async () => {
    const r = await createSalesOrder(t.staff, order([{ productId: t.chips.id, quantity: "1" }]));
    const find = async (q: string, extra: object = {}) =>
      (await listSalesOrders(t.staff, { q, page: 1, ...extra })).rows.map((o) => o.id);
    expect(await find("kh ali")).toEqual([r.id]);
    expect(await find("ALI KHAN")).toEqual([r.id]);
    expect(await find("ali bakers")).toEqual([]);
    expect(await find("cb01")).toEqual([r.id]); // chips' code
    expect(await find("item cb")).toEqual([r.id]); // its name
    expect(await find("gc01")).toEqual([]); // nimko is not on the order
    expect(await find("shahdara")).toEqual([r.id]); // the customer's area
    expect(await find(`#${r.number}`)).toEqual([r.id]);
    // The search and the area filter work together (they both filter the customer).
    const elsewhere = await createArea(t.ctx, { warehouseId: t.main.id, name: "Ravi" });
    expect(await find("ali", { areaId: elsewhere.id })).toEqual([]);
  });
});

describe("search from anywhere", () => {
  it("finds customers, orders and products together; links follow the role", async () => {
    const r = await createSalesOrder(t.staff, order([{ productId: t.chips.id, quantity: "1" }]));
    const kinds = async (q: string, ctx = t.ctx) =>
      (await globalSearch(ctx, q)).map((h) => `${h.kind}: ${h.title}`);

    expect(await kinds("khan ali")).toEqual([
      `Order: Order #${r.number} · Ali Khan`,
      "Customer: Ali Khan",
    ]);
    expect(await kinds("cb01")).toEqual([
      `Order: Order #${r.number} · Ali Khan`,
      "Product: CB01 Item CB01",
    ]);
    expect(await kinds(`#${r.number}`)).toContain(`Order: Order #${r.number} · Ali Khan`);
    expect(await kinds("   ")).toEqual([]);

    // Owner opens the statement; staff (no ledgers) see the customer's orders instead.
    const owner = (await globalSearch(t.ctx, "ali khan")).find((h) => h.kind === "Customer")!;
    const staff = (await globalSearch(t.staff, "ali khan")).find((h) => h.kind === "Customer")!;
    expect(owner.href).toBe(`/customers/${t.customer.id}/statement`);
    expect(staff.href).toBe("/orders?q=Ali%20Khan");
  });
});

describe("product set up under the wrong company", () => {
  const productInput = (companyId: string) => ({
    companyId,
    code: "CB01",
    name: "Item CB01",
    purchaseRate: "100",
    saleRate: "228",
    discountType: "AMOUNT_PER_UNIT",
    discountValue: "4",
    slabs: [{ fromDozens: "25", value: "8" }],
    effectiveFrom: "2026-10-01",
  });

  it("moves to a company of the same warehouse, with its stock and open orders", async () => {
    const r = await createSalesOrder(t.staff, order([{ productId: t.chips.id, quantity: "2" }]));
    await updateProduct(t.ctx, t.chips.id, productInput(t.golden.id));

    const product = await prisma.product.findUniqueOrThrow({ where: { id: t.chips.id } });
    expect(product.companyId).toBe(t.golden.id);
    // The stock stays where it is: it belongs to the product and the warehouse.
    expect((await stockPositions(t.ctx.db, t.main.id, [t.chips.id])).get(t.chips.id)!.onHand).toBe(
      360,
    );
    // The booked order's line moved with it; its bill is not touched.
    const line = await prisma.salesOrderLine.findFirstOrThrow({ where: { salesOrderId: r.id } });
    expect(line.companyId).toBe(t.golden.id);
    const bill = await prisma.bill.findFirstOrThrow({ where: { salesOrderId: r.id } });
    expect(bill.currentRevision).toBe(1);
    // Company reports read the product's current company, so its sales now count for Golden
    // (a bill saved under Crunchy, with a 48 special discount).
    const perCompany = await salesPerCompany(t.ctx, [
      {
        revisions: [
          {
            lines: [{ productId: t.chips.id, netAmount: "448.00" }],
            companyTotals: [{ companyId: t.crunchy.id, specialDiscount: "48.00" }],
          },
        ],
      },
    ]);
    expect([...perCompany].map(([c, v]) => [c, v.toFixed(2)])).toEqual([[t.golden.id, "400.00"]]);
    // What was posted stays as recorded: the purchase is still Crunchy's.
    const receipt = await prisma.goodsReceiptLine.findFirstOrThrow({
      where: { productId: t.chips.id },
      include: { goodsReceipt: true },
    });
    expect(receipt.goodsReceipt.companyId).toBe(t.crunchy.id);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: "Product", entityId: t.chips.id, action: "UPDATE" },
    });
    expect(audit.newValue).toMatchObject({ company: "Golden", movedOpenOrders: [r.number] });
  });

  it("cannot move to another warehouse's company while it has stock there", async () => {
    const faraway = await t.ctx.db.company.findFirstOrThrow({ where: { name: "Faraway" } });
    await expect(updateProduct(t.ctx, t.chips.id, productInput(faraway.id))).rejects.toThrow(
      /another warehouse/,
    );
  });
});
