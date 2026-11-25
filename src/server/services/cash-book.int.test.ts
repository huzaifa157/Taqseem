import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_EXPENSE_CATEGORIES } from "@/lib/expenses";
import { businessToday, toDateInput } from "@/lib/dates";

import { ForbiddenError } from "../auth/permissions";
import { prisma } from "../db/client";
import { createTenantDb } from "../db/tenant";
import {
  addCashMove,
  cashBook,
  computeCashBook,
  reverseCashEntry,
  saveCashCount,
  setOpeningCash,
} from "./cash-book";
import { createExpense } from "./expenses";
import { createArea } from "./master/areas";
import type { ServiceCtx } from "./master/common";
import { createCustomer } from "./master/customers";
import { createWarehouse } from "./master/warehouses";
import { createCustomerPayment } from "./payments/customer-payments";
import { dailyReport } from "./reports/daily";

const DAY = 86_400_000;
const today = businessToday();
/** A business date `n` days from today, as form text. */
const day = (n: number) => toDateInput(new Date(today.getTime() + n * DAY));
const asDate = (s: string) => new Date(`${s}T00:00:00.000Z`);

async function setup() {
  const suffix = randomUUID().slice(0, 8);
  const tenant = await prisma.tenant.create({ data: { name: `C ${suffix}`, slug: `c-${suffix}` } });
  const owner = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `c-${suffix}@t.local`,
      name: "O",
      role: "OWNER",
      passwordHash: "x",
    },
  });
  const ctx: ServiceCtx = {
    db: createTenantDb(tenant.id),
    user: { id: owner.id, role: "OWNER", tenantId: tenant.id },
  };
  await ctx.db.expenseCategory.createMany({
    data: DEFAULT_EXPENSE_CATEGORIES.map((name) => ({ tenantId: tenant.id, name })),
  });
  const wh = await createWarehouse(ctx, { name: "Main" });
  const area = await createArea(ctx, { warehouseId: wh.id, name: "Town" });
  const ali = await createCustomer(ctx, {
    name: "Ali",
    type: "RETAILER",
    areaId: area.id,
    openingBalance: "100000",
  });
  const petrol = await ctx.db.expenseCategory.findFirstOrThrow({ where: { name: "Petrol" } });
  const as = (role: "ACCOUNTANT" | "STAFF"): ServiceCtx => ({
    ...ctx,
    user: { ...ctx.user, role },
  });
  return { ctx, ali, petrol, as };
}

let t: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  t = await setup();
});

const collect = (date: string, amount: string, method = "CASH") =>
  createCustomerPayment(t.ctx, { customerId: t.ali.id, paymentDate: date, method, amount });
const spend = (date: string, amount: string, method = "CASH") =>
  createExpense(t.ctx, { expenseDate: date, categoryId: t.petrol.id, amount, method });
const book = async (from: string, to: string) => {
  const b = await computeCashBook(t.ctx.db, asDate(from), asDate(to));
  return b.days.map((d) => ({
    day: toDateInput(d.date),
    opening: d.opening.toFixed(2),
    closing: d.closing.toFixed(2),
  }));
};

describe("cash book", () => {
  it("carries the closing cash of each day into the next, from the opening cash", async () => {
    await setOpeningCash(t.ctx, { entryDate: day(-3), amount: "5000" });
    await collect(day(-3), "2000");
    await collect(day(-3), "700", "ONLINE"); // not cash
    await spend(day(-3), "300");
    await spend(day(-2), "999", "CHEQUE"); // not cash
    await addCashMove(t.ctx, { entryDate: day(-2), kind: "TAKEN_OUT", amount: "1000" });
    await addCashMove(t.ctx, { entryDate: day(-1), kind: "BANK_WITHDRAWAL", amount: "500" });
    await collect(day(-1), "1500");

    expect(await book(day(-3), day(0))).toEqual([
      { day: day(-3), opening: "5000.00", closing: "6700.00" },
      { day: day(-2), opening: "6700.00", closing: "5700.00" },
      { day: day(-1), opening: "5700.00", closing: "7700.00" },
      { day: day(0), opening: "7700.00", closing: "7700.00" },
    ]);
  });

  it("ignores cash before the opening cash; a new opening cash replaces the old", async () => {
    await collect(day(-5), "9000");
    await setOpeningCash(t.ctx, { entryDate: day(-4), amount: "1000" });
    expect(await book(day(-5), day(-4))).toEqual([
      { day: day(-4), opening: "1000.00", closing: "1000.00" },
    ]);
    await setOpeningCash(t.ctx, { entryDate: day(-2), amount: "2500" });
    expect(await book(day(-2), day(-2))).toEqual([
      { day: day(-2), opening: "2500.00", closing: "2500.00" },
    ]);
    const openings = await t.ctx.db.cashEntry.findMany({ where: { kind: "OPENING" } });
    expect(openings.map((o) => o.status).sort()).toEqual(["POSTED", "REVERSED"]);
  });

  it("starts at zero from the first cash day when no opening cash is set", async () => {
    await collect(day(-2), "800");
    await spend(day(-1), "200");
    expect(await book(day(-1), day(-1))).toEqual([
      { day: day(-1), opening: "800.00", closing: "600.00" },
    ]);
  });

  it("a count shows short or extra, and can set the book to the count", async () => {
    await setOpeningCash(t.ctx, { entryDate: day(-1), amount: "3000" });
    await collect(day(-1), "1000");
    const r1 = await saveCashCount(t.ctx, { countDate: day(-1), counted: "3900" });
    expect([r1.difference.toFixed(2), r1.corrected]).toEqual(["-100.00", false]);
    let b = await computeCashBook(t.ctx.db, asDate(day(-1)), asDate(day(-1)));
    expect(b.days[0].count?.difference.toFixed(2)).toBe("-100.00");

    // A recount replaces it; this time the book is set to the count.
    const r2 = await saveCashCount(t.ctx, { countDate: day(-1), counted: "3950", correct: "on" });
    expect([r2.difference.toFixed(2), r2.corrected]).toEqual(["-50.00", true]);
    b = await computeCashBook(t.ctx.db, asDate(day(-1)), asDate(day(0)));
    expect(b.days[0].closing.toFixed(2)).toBe("3950.00");
    expect(b.days[0].count?.difference.toFixed(2)).toBe("0.00");
    expect(b.days[1].opening.toFixed(2)).toBe("3950.00");
    expect(await t.ctx.db.cashCount.count()).toBe(1);
  });

  it("a cancelled entry leaves the book; idempotent on requestId", async () => {
    await setOpeningCash(t.ctx, { entryDate: day(-1), amount: "1000" });
    const requestId = randomUUID();
    const e1 = await addCashMove(t.ctx, {
      requestId,
      entryDate: day(-1),
      kind: "ADDED",
      amount: "400",
    });
    const e2 = await addCashMove(t.ctx, {
      requestId,
      entryDate: day(-1),
      kind: "ADDED",
      amount: "400",
    });
    expect(e2.id).toBe(e1.id);
    expect((await book(day(-1), day(-1)))[0].closing).toBe("1400.00");
    await reverseCashEntry(t.ctx, { id: e1.id, reason: "typed twice" });
    expect((await book(day(-1), day(-1)))[0].closing).toBe("1000.00");
    await expect(reverseCashEntry(t.ctx, { id: e1.id, reason: "again" })).rejects.toThrow(
      /already cancelled/,
    );
  });

  it("refuses future dates, and staff", async () => {
    await expect(setOpeningCash(t.ctx, { entryDate: day(1), amount: "10" })).rejects.toThrow(
      /after today/,
    );
    await expect(cashBook(t.as("STAFF"), {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      addCashMove(t.as("STAFF"), { entryDate: day(0), kind: "ADDED", amount: "1" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(cashBook(t.as("ACCOUNTANT"), {})).resolves.toBeTruthy();
  });

  it("the daily report shows opening and closing cash and the count", async () => {
    await setOpeningCash(t.ctx, { entryDate: day(-1), amount: "2000" });
    await collect(day(-1), "500");
    await addCashMove(t.ctx, { entryDate: day(-1), kind: "BANK_DEPOSIT", amount: "1000" });
    await saveCashCount(t.ctx, { countDate: day(-1), counted: "1450" });
    const r = await dailyReport(t.ctx, asDate(day(-1)));
    const cash = r.money!.cashInHand;
    expect(cash.net.toFixed(2)).toBe("500.00");
    expect([
      cash.book?.opening.toFixed(2),
      cash.book?.taken.toFixed(2),
      cash.book?.closing.toFixed(2),
      cash.book?.count?.difference.toFixed(2),
    ]).toEqual(["2000.00", "1000.00", "1500.00", "-50.00"]);
    expect(r.issues.some((i) => /short of the cash book/.test(i.text))).toBe(true);
  });
});
