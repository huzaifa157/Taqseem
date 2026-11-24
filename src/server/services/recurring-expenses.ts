import "server-only";

import { z } from "zod";

import { Prisma } from "@/generated/prisma/client";
import { businessToday } from "@/lib/dates";
import { PAYMENT_METHODS } from "@/lib/validation/purchasing";
import { dateSchema, idSchema, moneySchema, optionalText } from "@/lib/validation/master";

import { writeAudit } from "../audit";
import { assertCan } from "../auth/permissions";
import { ServiceError } from "./errors";
import type { ServiceCtx } from "./master/common";
import { found, nextDocumentNumber } from "./posting";

// Repeating daily expenses (lunch, petrol, a daily wage): set once, then added by themselves as
// that day's expense every day from the start date while the item is on. Each day's entry is a
// normal Expense (shown in the list, cancellable on its own); a day already added (or cancelled)
// is never added again (unique per item and date). Days are filled in whenever someone with
// expense access opens the app (see RecurringExpensesRunner), at most CATCH_UP_DAYS back.

const D = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v);
const DAY = 86_400_000;
/** How far back missing days are filled in (the laptop may be off for a while). */
const CATCH_UP_DAYS = 62;

export const recurringExpenseSchema = z.object({
  categoryId: idSchema,
  amount: moneySchema("amount").refine((v) => Number(v) > 0, "The amount must be more than zero"),
  method: z.enum(PAYMENT_METHODS).default("CASH"),
  paidTo: optionalText(120),
  note: optionalText(300),
  startDate: dateSchema("start date"),
});

export async function listRecurringExpenses(ctx: ServiceCtx) {
  assertCan(ctx.user.role, "expenses.manage");
  return ctx.db.recurringExpense.findMany({
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
    include: { category: { select: { name: true } } },
  });
}

export async function createRecurringExpense(ctx: ServiceCtx, input: unknown) {
  assertCan(ctx.user.role, "expenses.manage");
  const data = recurringExpenseSchema.parse(input);
  const item = await ctx.db.$transaction(async (tx) => {
    const category = await tx.expenseCategory.findUnique({ where: { id: data.categoryId } });
    if (!category || !category.isActive) throw new ServiceError("Choose an active category.");
    const created = await tx.recurringExpense.create({
      data: {
        tenantId: ctx.user.tenantId,
        categoryId: category.id,
        amount: D(data.amount),
        method: data.method,
        paidTo: data.paidTo,
        note: data.note,
        startDate: data.startDate,
        createdById: ctx.user.id,
      },
    });
    await writeAudit(tx, ctx.user, {
      action: "CREATE",
      entityType: "RecurringExpense",
      entityId: created.id,
      newValue: { ...created, category: category.name },
    });
    return created;
  });
  // Days from the start date up to today are added at once.
  await postDueRecurringExpenses(ctx);
  return item;
}

/** Stops (or starts again) a repeating expense; days already added stay. */
export async function setRecurringExpenseActive(ctx: ServiceCtx, id: string, active: boolean) {
  assertCan(ctx.user.role, "expenses.manage");
  await ctx.db.$transaction(async (tx) => {
    const before = found(await tx.recurringExpense.findUnique({ where: { id } }), "expense");
    await tx.recurringExpense.update({ where: { id }, data: { isActive: active } });
    await writeAudit(tx, ctx.user, {
      action: "UPDATE",
      entityType: "RecurringExpense",
      entityId: id,
      oldValue: { isActive: before.isActive },
      newValue: { isActive: active },
    });
  });
  if (active) await postDueRecurringExpenses(ctx);
}

/** A new daily amount, from the next day added on (days already added keep theirs). */
export async function setRecurringExpenseAmount(ctx: ServiceCtx, id: string, amount: unknown) {
  assertCan(ctx.user.role, "expenses.manage");
  const value = moneySchema("amount")
    .refine((v) => Number(v) > 0, "The amount must be more than zero")
    .parse(amount);
  await ctx.db.$transaction(async (tx) => {
    const before = found(await tx.recurringExpense.findUnique({ where: { id } }), "expense");
    await tx.recurringExpense.update({ where: { id }, data: { amount: D(value) } });
    await writeAudit(tx, ctx.user, {
      action: "UPDATE",
      entityType: "RecurringExpense",
      entityId: id,
      oldValue: { amount: before.amount },
      newValue: { amount: value },
    });
  });
}

/**
 * Adds each active repeating expense for every day from its start (at most CATCH_UP_DAYS back)
 * up to today that does not have its entry yet. Returns how many entries were added.
 */
export async function postDueRecurringExpenses(ctx: ServiceCtx, today = businessToday()) {
  assertCan(ctx.user.role, "expenses.manage");
  const items = await ctx.db.recurringExpense.findMany({
    where: { isActive: true, startDate: { lte: today } },
  });
  const earliest = new Date(today.getTime() - CATCH_UP_DAYS * DAY);
  let added = 0;
  for (const item of items) {
    const from = item.startDate > earliest ? item.startDate : earliest;
    const done = await ctx.db.expense.findMany({
      where: { recurringExpenseId: item.id, expenseDate: { gte: from, lte: today } },
      select: { expenseDate: true },
    });
    const have = new Set(done.map((e) => e.expenseDate.getTime()));
    const missing: Date[] = [];
    for (let t = from.getTime(); t <= today.getTime(); t += DAY)
      if (!have.has(t)) missing.push(new Date(t));
    if (missing.length === 0) continue;
    try {
      await ctx.db.$transaction(async (tx) => {
        for (const day of missing) {
          const expense = await tx.expense.create({
            data: {
              tenantId: ctx.user.tenantId,
              number: await nextDocumentNumber(tx, ctx, "EXPENSE"),
              expenseDate: day,
              categoryId: item.categoryId,
              amount: item.amount,
              method: item.method,
              paidTo: item.paidTo,
              note: item.note ?? "Every day",
              recurringExpenseId: item.id,
              createdById: ctx.user.id,
            },
          });
          await writeAudit(tx, ctx.user, {
            action: "POST",
            entityType: "Expense",
            entityId: expense.id,
            newValue: { ...expense, repeating: true },
          });
        }
      });
      added += missing.length;
    } catch (error) {
      // Another computer added the same days at the same moment: nothing to do.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"))
        throw error;
    }
  }
  return added;
}
