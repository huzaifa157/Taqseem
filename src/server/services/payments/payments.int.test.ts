import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ForbiddenError } from "../../auth/permissions";
import { prisma } from "../../db/client";
import { createTenantDb } from "../../db/tenant";
import { createTrip, dispatchTrip } from "../delivery/trips";
import { createArea } from "../master/areas";
import { createBike } from "../master/bikes";
import type { ServiceCtx } from "../master/common";
import { createCompany } from "../master/companies";
import { createCustomer } from "../master/customers";
import { createProduct } from "../master/products";
import { createStaff } from "../master/staff";
import { createWarehouse } from "../master/warehouses";
import { createGoodsReceipt } from "../purchasing/goods-receipts";
import { createSalesOrder } from "../sales/orders";
import { getBillView } from "../sales/bills";
import { customerPending } from "../sales/positions";
import { getCustomerStatement } from "../statements";
import {
  bounceCheque,
  clearCheque,
  clearCustomerFlag,
  createCustomerPayment,
  customerDebt,
  getCustomerPayment,
  listCustomerPayments,
  paymentContext,
  reverseCustomerPayment,
} from "./customer-payments";
import { createOldBill, listOldBills, removeOldBill } from "./old-bills";

const DAY = "2026-10-25";

async function setup() {
  const suffix = randomUUID().slice(0, 8);
  const tenant = await prisma.tenant.create({ data: { name: `Y ${suffix}`, slug: `y-${suffix}` } });
  const owner = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `y-${suffix}@t.local`,
      name: "Owner",
      role: "OWNER",
      passwordHash: "x",
    },
  });
  const ctx: ServiceCtx = {
    db: createTenantDb(tenant.id),
    user: { id: owner.id, role: "OWNER", tenantId: tenant.id },
  };
  const as = (role: "ACCOUNTANT" | "STAFF"): ServiceCtx => ({
    ...ctx,
    user: { ...ctx.user, role },
  });
  const wh = await createWarehouse(ctx, { name: "Main" });
  const area = await createArea(ctx, { warehouseId: wh.id, name: "Shahdara" });
  const company = (name: string) =>
    createCompany(ctx, { warehouseId: wh.id, name, paymentTermsDays: "15", openingBalance: "" });
  const crunchy = await company("Crunchy");
  const golden = await company("Golden");
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
  const chips = await product(crunchy.id, "CB01", "200", {
    discountType: "AMOUNT_PER_UNIT",
    discountValue: "4",
  });
  const nimko = await product(golden.id, "GC01", "150");
  for (const [companyId, productId] of [
    [crunchy.id, chips.id],
    [golden.id, nimko.id],
  ] as const)
    await createGoodsReceipt(ctx, {
      companyId,
      receivedDate: "2026-10-01",
      lines: [{ productId, quantity: "50" }],
    });
  const driver = await createStaff(ctx, { name: "Aslam", role: "DRIVER", monthlySalary: "0" });
  const bike = await createBike(ctx, { name: "Bike 1", capacity: "90", driverId: driver.id });
  const ali = await createCustomer(ctx, {
    name: "Ali",
    type: "RETAILER",
    areaId: area.id,
    openingBalance: "4000",
  });
  const bilal = await createCustomer(ctx, { name: "Bilal", type: "RETAILER", areaId: area.id });

  // One dispatched bill for Ali: Crunchy 1960 (10 dz × 196), Golden 300 (2 dz × 150).
  const order = await createSalesOrder(ctx, {
    customerId: ali.id,
    orderDate: "2026-10-24",
    deliveryDate: DAY,
    lines: [
      { productId: chips.id, quantity: "10" },
      { productId: nimko.id, quantity: "2" },
    ],
  });
  const trip = await createTrip(ctx, {
    tripDate: DAY,
    bikeId: bike.id,
    driverId: driver.id,
    orderIds: [order.id],
  });
  await dispatchTrip(ctx, { id: trip.id });
  return { ctx, as, crunchy, golden, ali, bilal, order };
}

let t: Awaited<ReturnType<typeof setup>>;
// Opening balances are dated "today": keep today fixed, just after the fixture dates.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-25T07:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

beforeEach(async () => {
  t = await setup();
});

const pay = (extra: object, ctx = t.ctx) =>
  createCustomerPayment(ctx, {
    customerId: t.ali.id,
    paymentDate: "2026-10-26",
    method: "CASH",
    ...extra,
  });

const pending = async (customerId = t.ali.id) =>
  (await customerPending(t.ctx.db, customerId)).total.toFixed(2);

describe("office payments, oldest debt first", () => {
  it("pays the opening balance, then the oldest bill, as one entry on one account", async () => {
    expect(await pending()).toBe("6260.00");
    const p = await pay({ amount: "4500" });
    // 4000 opening balance first, then 500 of the 2260 bill.
    const entries = await t.ctx.db.ledgerEntry.findMany({
      where: { referenceType: "CustomerPayment", referenceId: p.id },
    });
    expect(entries.map((e) => [e.companyId, e.credit.toFixed(2)])).toEqual([[null, "4500.00"]]);
    const view = await getCustomerPayment(t.ctx, p.id);
    expect(view.allocations.map((a) => [a.companyId, a.amount.toFixed(2)])).toEqual([
      [null, "500.00"],
    ]);
    expect(view.notOnBills.toFixed(2)).toBe("4000.00");
    expect(await pending()).toBe("1760.00");

    // A second payment of exactly the rest clears the bill.
    await pay({ amount: "1760" });
    expect(await pending()).toBe("0.00");
    const { debt } = await customerDebt(t.ctx.db, t.ali.id);
    expect(debt.bills).toHaveLength(0);
    expect(debt.unbilled.toFixed(2)).toBe("0.00");
  });

  it("shows what is owed bill by bill, and keeps any extra as an advance", async () => {
    const before = await paymentContext(t.ctx, t.ali.id);
    expect([before.pending, before.unbilled]).toEqual(["6260.00", "4000.00"]);
    expect(before.bills.map((b) => b.outstanding)).toEqual(["2260.00"]);
    await pay({ amount: "7000" });
    expect(await pending()).toBe("-740.00");
    expect((await paymentContext(t.ctx, t.ali.id)).bills).toEqual([]);
  });

  it("takes an advance when nothing is owed, and retries never post twice", async () => {
    const requestId = randomUUID();
    const advance = { customerId: t.bilal.id, amount: "100", requestId };
    const first = await pay(advance);
    const again = await pay(advance);
    expect(again.id).toBe(first.id);
    expect(await pending(t.bilal.id)).toBe("-100.00");
  });

  it("is for owners and accountants only", async () => {
    await expect(pay({ amount: "10" }, t.as("STAFF"))).rejects.toThrow(ForbiddenError);
    await expect(listCustomerPayments(t.as("STAFF"), { page: 1 })).rejects.toThrow(ForbiddenError);
    await pay({ amount: "10" }, t.as("ACCOUNTANT"));
  });
});

describe("cheques", () => {
  const cheque = (amount: string) =>
    pay({
      method: "CHEQUE",
      amount,
      chequeNo: "123456",
      bankName: "HBL",
      chequeDate: "2026-10-30",
    });

  it("a bounced cheque reverses the payment, brings the debt back and flags the customer", async () => {
    const p = await cheque("6260");
    expect(await pending()).toBe("0.00");
    await bounceCheque(t.ctx, { id: p.id, reason: "insufficient funds" });
    expect(await pending()).toBe("6260.00");

    const view = await getCustomerPayment(t.ctx, p.id);
    expect([view.status, view.cheque!.status]).toEqual(["REVERSED", "BOUNCED"]);
    const bounce = await t.ctx.db.ledgerEntry.findMany({
      where: { referenceId: p.id, type: "CHEQUE_BOUNCE" },
    });
    expect(bounce).toHaveLength(1);
    expect(bounce.every((e) => e.reversalOfId)).toBe(true);
    const customer = await t.ctx.db.customer.findUniqueOrThrow({ where: { id: t.ali.id } });
    expect(customer.isFlagged).toBe(true);
    expect(customer.flagReason).toMatch(/Cheque 123456 \(HBL\).*insufficient funds/);
    // The bill is unpaid again.
    expect((await customerDebt(t.ctx.db, t.ali.id)).debt.bills).toHaveLength(1);

    await expect(bounceCheque(t.ctx, { id: p.id, reason: "again" })).rejects.toThrow(/reversed/);
    const audit = await t.ctx.db.auditLog.count({
      where: { entityType: "Cheque", action: "REVERSE" },
    });
    expect(audit).toBe(1);

    await expect(clearCustomerFlag(t.as("STAFF"), { id: t.ali.id })).rejects.toThrow(
      ForbiddenError,
    );
    await clearCustomerFlag(t.ctx, { id: t.ali.id });
    const after = await t.ctx.db.customer.findUniqueOrThrow({ where: { id: t.ali.id } });
    expect([after.isFlagged, after.flagReason]).toEqual([false, null]);
  });

  it("a cleared cheque cannot bounce or be reversed; a cash payment can be reversed", async () => {
    const c = await cheque("500");
    await clearCheque(t.ctx, { id: c.id });
    await expect(bounceCheque(t.ctx, { id: c.id, reason: "late" })).rejects.toThrow(
      /already cleared/,
    );
    await expect(reverseCustomerPayment(t.ctx, { id: c.id, reason: "mistake" })).rejects.toThrow(
      /cleared/,
    );
    expect(await pending()).toBe("5760.00");

    const cash = await pay({ amount: "760" });
    await reverseCustomerPayment(t.ctx, { id: cash.id, reason: "entered twice" });
    expect(await pending()).toBe("5760.00");
    const list = await listCustomerPayments(t.ctx, { page: 1, status: "REVERSED" });
    expect(list.rows.map((r) => r.id)).toEqual([cash.id]);
    const pendingCheques = await listCustomerPayments(t.ctx, { page: 1, cheque: "PENDING" });
    expect(pendingCheques.total).toBe(0);
  });
});

describe("ledger views", () => {
  it("the customer statement is one account: one row per bill and per payment", async () => {
    await pay({ amount: "4500" });
    const st = await getCustomerStatement(t.ctx, t.ali.id, {});
    expect(st.closing.toFixed(2)).toBe("1760.00");
    expect(st.rows.map((r) => [r.typeLabel, r.debit.toFixed(2), r.credit.toFixed(2)])).toEqual([
      ["Opening balance", "4000.00", "0.00"],
      ["Bill", "2260.00", "0.00"],
      ["Payment", "0.00", "4500.00"],
    ]);
    await expect(getCustomerStatement(t.as("STAFF"), t.ali.id, {})).rejects.toThrow(ForbiddenError);
  });
});

describe("old balance (paper bills from before the app)", () => {
  const oldBill = (amount: string, extra: object = {}, ctx = t.ctx) =>
    createOldBill(ctx, { customerId: t.ali.id, billDate: "2026-09-01", amount, ...extra });

  it("counts in what the customer owes, on the statement and the next bill", async () => {
    const requestId = randomUUID();
    const a = await oldBill("700", { billNo: "B-12", requestId });
    expect((await oldBill("700", { billNo: "B-12", requestId })).id).toBe(a.id); // retry
    const entry = await t.ctx.db.ledgerEntry.findFirstOrThrow({
      where: { referenceType: "CustomerOldBill", referenceId: a.id },
    });
    expect([entry.type, entry.companyId, entry.debit.toFixed(2)]).toEqual([
      "OPENING_BALANCE",
      null,
      "700.00",
    ]);
    expect(await pending()).toBe("6960.00");
    const statement = await getCustomerStatement(t.ctx, t.ali.id, {});
    expect(statement.rows.some((r) => r.description.startsWith("Old bill #B-12"))).toBe(true);

    const order = await createSalesOrder(t.ctx, {
      customerId: t.ali.id,
      orderDate: "2026-10-26",
      deliveryDate: "2026-10-27",
      lines: [{ productId: (await t.ctx.db.product.findFirstOrThrow()).id, quantity: "1" }],
    });
    expect((await getBillView(t.ctx, order.id)).previous.toFixed(2)).toBe("6960.00");
  });

  it("an amount added to the balance (no bill number) reads 'Added to balance' with its note", async () => {
    await oldBill("2000", { note: "old khata" });
    const statement = await getCustomerStatement(t.ctx, t.ali.id, {});
    expect(statement.rows.some((r) => r.description === "Added to balance: old khata")).toBe(true);
    expect(await pending()).toBe("8260.00");
    // It is in "previous balance" on the customer's next bill.
    const order = await createSalesOrder(t.ctx, {
      customerId: t.ali.id,
      orderDate: "2026-10-26",
      deliveryDate: "2026-10-27",
      lines: [{ productId: (await t.ctx.db.product.findFirstOrThrow()).id, quantity: "1" }],
    });
    expect((await getBillView(t.ctx, order.id)).previous.toFixed(2)).toBe("8260.00");
  });

  it("is paid before anything else, oldest old bill first", async () => {
    await oldBill("700", { billDate: "2026-08-01" });
    await oldBill("300", { billDate: "2026-09-01" });
    await pay({ amount: "900" });
    const unpaid = async () => (await listOldBills(t.ctx, t.ali.id)).unpaid.toFixed(2);
    const list = await listOldBills(t.ctx, t.ali.id);
    expect(list.rows.map((r) => [r.paid.toFixed(2), r.unpaid.toFixed(2)])).toEqual([
      ["700.00", "0.00"],
      ["200.00", "100.00"],
    ]);
    // Still owed with no bill: the 100 of the old balance and the 4000 opening balance.
    expect((await paymentContext(t.ctx, t.ali.id)).unbilled).toBe("4100.00");

    // A bounced cheque brings it back.
    const cheque = await pay({
      amount: "100",
      method: "CHEQUE",
      chequeNo: "1",
      bankName: "HBL",
      chequeDate: "2026-10-26",
    });
    expect(await unpaid()).toBe("0.00");
    await bounceCheque(t.ctx, { id: cheque.id, reason: "No funds" });
    expect(await unpaid()).toBe("100.00");
  });

  it("is removed by a reversal, not once payments have used it up", async () => {
    const a = await oldBill("700");
    const b = await oldBill("300");
    await pay({ amount: "500" }); // 500 of the old balance paid
    await expect(removeOldBill(t.ctx, { id: a.id, reason: "Typo" })).rejects.toThrow(
      "can't be removed",
    );
    await removeOldBill(t.ctx, { id: b.id, reason: "Entered twice" });
    await expect(removeOldBill(t.ctx, { id: b.id, reason: "Again" })).rejects.toThrow(
      "already removed",
    );
    expect((await listOldBills(t.ctx, t.ali.id)).unpaid.toFixed(2)).toBe("200.00");
    expect(
      await t.ctx.db.auditLog.count({ where: { entityType: "CustomerOldBill", entityId: b.id } }),
    ).toBe(2);
  });

  it("customer entries need no company; company entries still do", async () => {
    await expect(
      t.ctx.db.ledgerEntry.create({
        data: {
          tenantId: t.ctx.user.tenantId,
          partyType: "COMPANY",
          type: "COMPANY_BILL",
          entryDate: new Date(DAY),
          credit: 1,
        },
      }),
    ).rejects.toThrow(/LedgerEntry_party_check/);
  });

  it("is for the owner and accountant only", async () => {
    await expect(oldBill("100", {}, t.as("STAFF"))).rejects.toThrow(ForbiddenError);
    await oldBill("100", {}, t.as("ACCOUNTANT"));
  });
});
