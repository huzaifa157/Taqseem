import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "../db/client";
import { createTenantDb } from "../db/tenant";
import { clearEntries, previewClearEntries } from "./clear-entries";
import { setOpeningStock } from "./inventory";
import { createArea } from "./master/areas";
import type { ServiceCtx } from "./master/common";
import { createCompany } from "./master/companies";
import { createCustomer } from "./master/customers";
import { createProduct } from "./master/products";
import { createWarehouse } from "./master/warehouses";
import { createCustomerPayment } from "./payments/customer-payments";
import { createOldBill } from "./payments/old-bills";
import { createGoodsReceipt } from "./purchasing/goods-receipts";
import { createCompanyPayment } from "./purchasing/payments";
import { createCounterSale } from "./sales/counter";

// Settings → Clear entries: trial orders, purchases, stock and their money go; master data, old
// balances and the opening balances stay, and every balance left still adds up.

async function setup(name: string) {
  const suffix = randomUUID().slice(0, 8);
  const tenant = await prisma.tenant.create({ data: { name, slug: `x-${suffix}` } });
  const owner = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `x-${suffix}@t.local`,
      name: "Owner",
      role: "OWNER",
      passwordHash: "x",
    },
  });
  const ctx: ServiceCtx = {
    db: createTenantDb(tenant.id),
    user: { id: owner.id, role: "OWNER", tenantId: tenant.id },
  };
  const main = await createWarehouse(ctx, { name: "Main" });
  const area = await createArea(ctx, { warehouseId: main.id, name: "Shahdara" });
  const crunchy = await createCompany(ctx, {
    warehouseId: main.id,
    name: "Crunchy",
    paymentTermsDays: "15",
    openingBalance: "2000",
  });
  const chips = await createProduct(ctx, {
    companyId: crunchy.id,
    code: "CB01",
    name: "Chips",
    purchaseRate: "100",
    saleRate: "200",
    effectiveFrom: "2026-10-01",
  });
  const customer = await createCustomer(ctx, {
    name: "Ali Khan",
    type: "RETAILER",
    areaId: area.id,
    creditLimit: "100000",
    openingBalances: { [crunchy.id]: "4000" },
  });
  await setOpeningStock(ctx, {
    stockDate: "2026-10-01",
    lines: [{ productId: chips.id, quantity: "10" }],
  });
  await createGoodsReceipt(ctx, {
    companyId: crunchy.id,
    receivedDate: "2026-10-02",
    lines: [{ productId: chips.id, quantity: "30" }],
  });
  await createCompanyPayment(ctx, {
    companyId: crunchy.id,
    paymentDate: "2026-10-03",
    method: "CASH",
    amount: "1000",
  });
  // A paper bill from before the app, partly paid: both stay.
  await createOldBill(ctx, { customerId: customer.id, billDate: "2026-09-01", amount: "700" });
  await createCustomerPayment(ctx, {
    customerId: customer.id,
    paymentDate: "2026-10-03",
    method: "CASH",
    amount: "300",
  });
  // Two counter sales, one paid at the counter.
  await createCounterSale(ctx, {
    customerId: customer.id,
    saleDate: "2026-10-20",
    lines: [{ productId: chips.id, quantity: "5" }],
    paidAmount: "500",
    method: "CASH",
  });
  await createCounterSale(ctx, {
    customerId: customer.id,
    saleDate: "2026-10-20",
    lines: [{ productId: chips.id, quantity: "2" }],
  });
  return { ctx, crunchy, chips, customer };
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-20T07:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

describe("clear entries", () => {
  it("removes the trial entries and keeps master data, old balances and opening balances", async () => {
    const t = await setup("Clear");
    const other = await setup("Untouched");
    const db = t.ctx.db;

    expect(await previewClearEntries(t.ctx)).toMatchObject({
      salesOrders: 2,
      bills: 2,
      customerPayments: 1,
      goodsReceipts: 1,
      companyPayments: 1,
    });
    await expect(clearEntries(t.ctx, { confirm: "clear" })).rejects.toThrow(/Type CLEAR/);
    const staff: ServiceCtx = { ...t.ctx, user: { ...t.ctx.user, role: "STAFF" } };
    await expect(clearEntries(staff, { confirm: "CLEAR" })).rejects.toThrow(/permission/);

    const cleared = await clearEntries(t.ctx, { confirm: "CLEAR" });
    expect(cleared).toMatchObject({ salesOrders: 2, bills: 2, customerPayments: 1 });

    expect(await db.salesOrder.count()).toBe(0);
    expect(await db.bill.count()).toBe(0);
    expect(await db.goodsReceipt.count()).toBe(0);
    expect(await db.companyPayment.count()).toBe(0);
    expect(await db.stockMovement.count()).toBe(0);
    expect(await db.batch.count()).toBe(0);
    // Master data stays.
    expect(await db.product.count()).toBe(1);
    expect(await db.customer.count()).toBe(1);
    expect(await db.company.count()).toBe(1);
    // The old bill and the payment that settled it stay; so do the opening balances.
    expect(await db.customerOldBill.count()).toBe(1);
    expect(await db.customerPayment.count()).toBe(1);
    const left = await db.ledgerEntry.findMany({
      select: { type: true },
      orderBy: { type: "asc" },
    });
    expect(left.map((e) => e.type).sort()).toEqual(
      ["CUSTOMER_PAYMENT", "OPENING_BALANCE", "OPENING_BALANCE", "OPENING_BALANCE"].sort(),
    );
    // Numbers start again at 1, and the journals are locked again.
    await setOpeningStock(t.ctx, {
      stockDate: "2026-10-20",
      lines: [{ productId: t.chips.id, quantity: "4" }],
    });
    const sale = await createCounterSale(t.ctx, {
      customerId: t.customer.id,
      saleDate: "2026-10-20",
      lines: [{ productId: t.chips.id, quantity: "1" }],
    });
    const order = await db.salesOrder.findUniqueOrThrow({
      where: { id: sale.id },
      include: { bill: true },
    });
    expect(order.number).toBe(1);
    expect(order.bill!.number).toBe(1);
    await expect(
      prisma.$executeRawUnsafe(
        `DELETE FROM "LedgerEntry" WHERE "tenantId" = $1`,
        t.ctx.user.tenantId,
      ),
    ).rejects.toThrow(/append-only/);

    // The other business is untouched.
    expect(await other.ctx.db.salesOrder.count()).toBe(2);
    expect(await other.ctx.db.stockMovement.count()).toBeGreaterThan(0);
    // The clear is in the audit log.
    expect(await db.auditLog.count({ where: { entityType: "Entries" } })).toBe(1);
  });
});
