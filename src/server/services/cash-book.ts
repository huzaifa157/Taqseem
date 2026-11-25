import "server-only";

import { Prisma } from "@/generated/prisma/client";
import type { CashDirection, CashEntryKind } from "@/generated/prisma/enums";
import { businessToday } from "@/lib/dates";
import { cashCountSchema, cashMoveSchema, openingCashSchema } from "@/lib/validation/cash";
import { reverseSchema } from "@/lib/validation/purchasing";

import { writeAudit } from "../audit";
import { assertCan } from "../auth/permissions";
import type { TenantTx } from "../db/tenant";
import { ServiceError } from "./errors";
import type { ServiceCtx } from "./master/common";
import { found, nextDocumentNumber } from "./posting";

// Cash book (owner and accountant: payments.manage). The cash in the drawer, day by day:
//
//   opening (the day before's closing; on the first day, the opening cash entered)
//   + cash collected (customer payments in cash: counter sales, day-end, office)
//   − cash expenses − cash paid to companies
//   + cash put in / brought from the bank − cash taken out / taken to the bank
//   ± count differences
//   = closing.
//
// Sales, payments and expenses are read from their own tables, so the book never needs a second
// entry for them. Only what has no other home is a CashEntry. A cancelled payment or expense
// leaves the book on its own day, as in the daily report. The night's count (CashCount) is kept
// beside the book; when "set the book to the count" is ticked, the shortage or extra is posted
// as a count difference so the next day starts from the cash really there.

const D = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v);
const ZERO = D(0);
const DAY = 86_400_000;
/** Longest stretch walked at once (the book itself starts from the opening cash). */
const MAX_DAYS = 3700;

type Reader = Pick<
  TenantTx,
  "customerPayment" | "expense" | "companyPayment" | "cashEntry" | "cashCount"
>;

const key = (d: Date) => d.toISOString().slice(0, 10);

const DIRECTION: Record<CashEntryKind, CashDirection | null> = {
  OPENING: "IN",
  ADDED: "IN",
  BANK_WITHDRAWAL: "IN",
  TAKEN_OUT: "OUT",
  BANK_DEPOSIT: "OUT",
  COUNT_DIFFERENCE: null,
};

export type CashDay = {
  date: Date;
  opening: Prisma.Decimal;
  /** Cash collected from customers. */
  collected: Prisma.Decimal;
  expenses: Prisma.Decimal;
  toCompanies: Prisma.Decimal;
  /** Put in, brought from the bank, extra found at a count. */
  added: Prisma.Decimal;
  /** Taken out, taken to the bank, short at a count. */
  taken: Prisma.Decimal;
  closing: Prisma.Decimal;
  count: { counted: Prisma.Decimal; difference: Prisma.Decimal; note: string | null } | null;
};

type Flow = Omit<CashDay, "date" | "opening" | "closing" | "count">;
const emptyFlow = (): Flow => ({
  collected: ZERO,
  expenses: ZERO,
  toCompanies: ZERO,
  added: ZERO,
  taken: ZERO,
});

/**
 * The book's days from `from` to `to` (both @db.Date), each with its opening and closing cash.
 * Days before the opening cash are left out. Without opening cash the book starts at zero on
 * the first day with any cash.
 */
export async function computeCashBook(db: Reader, from: Date, to: Date) {
  const opening = await db.cashEntry.findFirst({
    where: { kind: "OPENING", status: "POSTED" },
    orderBy: [{ entryDate: "desc" }, { createdAt: "desc" }],
  });
  const since = opening?.entryDate;
  const range = { ...(since ? { gte: since } : {}), lte: to };
  const [collected, expenses, toCompanies, entries, counts] = await Promise.all([
    db.customerPayment.groupBy({
      by: ["paymentDate"],
      where: { method: "CASH", status: "POSTED", paymentDate: range },
      _sum: { amount: true },
    }),
    db.expense.groupBy({
      by: ["expenseDate"],
      where: { method: "CASH", status: "POSTED", expenseDate: range },
      _sum: { amount: true },
    }),
    db.companyPayment.groupBy({
      by: ["paymentDate"],
      where: { method: "CASH", status: "POSTED", paymentDate: range },
      _sum: { amount: true },
    }),
    db.cashEntry.groupBy({
      by: ["entryDate", "direction"],
      where: { status: "POSTED", kind: { not: "OPENING" }, entryDate: range },
      _sum: { amount: true },
    }),
    db.cashCount.findMany({ where: { countDate: { gte: from, lte: to } } }),
  ]);

  const flows = new Map<string, Flow>();
  const flow = (d: Date) => {
    const k = key(d);
    let f = flows.get(k);
    if (!f) flows.set(k, (f = emptyFlow()));
    return f;
  };
  for (const g of collected) flow(g.paymentDate).collected = D(g._sum.amount ?? 0);
  for (const g of expenses) flow(g.expenseDate).expenses = D(g._sum.amount ?? 0);
  for (const g of toCompanies) flow(g.paymentDate).toCompanies = D(g._sum.amount ?? 0);
  for (const g of entries) {
    const f = flow(g.entryDate);
    if (g.direction === "IN") f.added = f.added.add(g._sum.amount ?? 0);
    else f.taken = f.taken.add(g._sum.amount ?? 0);
  }
  const countByDay = new Map(counts.map((c) => [key(c.countDate), c]));

  const firstFlow = [...flows.keys()].sort()[0];
  const start = since ?? (firstFlow ? new Date(`${firstFlow}T00:00:00.000Z`) : from);
  const days: CashDay[] = [];
  let balance = since ? D(opening!.amount) : ZERO;
  const begin = Math.max(start.getTime(), to.getTime() - MAX_DAYS * DAY);
  for (let t = begin; t <= to.getTime(); t += DAY) {
    const date = new Date(t);
    const f = flows.get(key(date)) ?? emptyFlow();
    const open = balance;
    balance = open.add(f.collected).sub(f.expenses).sub(f.toCompanies).add(f.added).sub(f.taken);
    if (t < from.getTime()) continue;
    const c = countByDay.get(key(date));
    days.push({
      date,
      opening: open,
      ...f,
      closing: balance,
      count: c
        ? { counted: D(c.counted), difference: D(c.counted).sub(balance), note: c.note }
        : null,
    });
  }
  return { opening, days };
}

/** The cash book page: the opening cash, the days of the range (newest first) and the entries. */
export async function cashBook(ctx: ServiceCtx, range: { from?: Date; to?: Date }) {
  assertCan(ctx.user.role, "payments.manage");
  const today = businessToday();
  const to = range.to && range.to < today ? range.to : today;
  const from = range.from ?? new Date(to.getTime() - 30 * DAY);
  const [{ opening, days }, entries, current] = await Promise.all([
    computeCashBook(ctx.db, from, to),
    ctx.db.cashEntry.findMany({
      where: { entryDate: { gte: from, lte: to } },
      orderBy: [{ entryDate: "desc" }, { number: "desc" }],
    }),
    computeCashBook(ctx.db, today, today),
  ]);
  const quiet = (d: CashDay) =>
    !d.count && [d.collected, d.expenses, d.toCompanies, d.added, d.taken].every((v) => v.isZero());
  return {
    from,
    to,
    opening,
    today: current.days[0] ?? null,
    // Days with nothing in or out are left out (their cash is the day before's), except the last.
    days: days.filter((d, i) => !quiet(d) || i === days.length - 1).reverse(),
    entries,
  };
}

/** One day of the book (for the daily report), or null when the day is before the opening cash. */
export async function cashDay(db: Reader, date: Date) {
  const { opening, days } = await computeCashBook(db, date, date);
  return { hasOpening: opening !== null, day: days[0] ?? null };
}

/**
 * Sets the opening cash. One at a time: an earlier one is cancelled and the book starts again
 * from the new date.
 */
export async function setOpeningCash(ctx: ServiceCtx, input: unknown) {
  assertCan(ctx.user.role, "payments.manage");
  const data = openingCashSchema.parse(input);
  if (data.entryDate > businessToday()) throw new ServiceError("The date cannot be after today.");
  return ctx.db.$transaction(async (tx) => {
    if (data.requestId) {
      const existing = await tx.cashEntry.findUnique({
        where: { tenantId_requestId: { tenantId: ctx.user.tenantId, requestId: data.requestId } },
      });
      if (existing) return existing;
    }
    const before = await tx.cashEntry.findMany({ where: { kind: "OPENING", status: "POSTED" } });
    for (const old of before) {
      await tx.cashEntry.update({
        where: { id: old.id },
        data: {
          status: "REVERSED",
          reversedAt: new Date(),
          reversalReason: "Replaced by new opening cash",
        },
      });
      await writeAudit(tx, ctx.user, {
        action: "REVERSE",
        entityType: "CashEntry",
        entityId: old.id,
        oldValue: { status: "POSTED", amount: old.amount, entryDate: old.entryDate },
        newValue: { status: "REVERSED", reason: "Replaced by new opening cash" },
      });
    }
    const entry = await tx.cashEntry.create({
      data: {
        tenantId: ctx.user.tenantId,
        number: await nextDocumentNumber(tx, ctx, "CASH_ENTRY"),
        entryDate: data.entryDate,
        kind: "OPENING",
        direction: "IN",
        amount: D(data.amount),
        note: data.note,
        requestId: data.requestId,
        createdById: ctx.user.id,
      },
    });
    await writeAudit(tx, ctx.user, {
      action: "POST",
      entityType: "CashEntry",
      entityId: entry.id,
      newValue: entry,
      requestId: data.requestId,
    });
    return entry;
  });
}

/** Cash put in or taken out, or taken to / brought from the bank. */
export async function addCashMove(ctx: ServiceCtx, input: unknown) {
  assertCan(ctx.user.role, "payments.manage");
  const data = cashMoveSchema.parse(input);
  if (data.entryDate > businessToday()) throw new ServiceError("The date cannot be after today.");
  return ctx.db.$transaction(async (tx) => {
    if (data.requestId) {
      const existing = await tx.cashEntry.findUnique({
        where: { tenantId_requestId: { tenantId: ctx.user.tenantId, requestId: data.requestId } },
      });
      if (existing) return existing;
    }
    const entry = await tx.cashEntry.create({
      data: {
        tenantId: ctx.user.tenantId,
        number: await nextDocumentNumber(tx, ctx, "CASH_ENTRY"),
        entryDate: data.entryDate,
        kind: data.kind,
        direction: DIRECTION[data.kind]!,
        amount: D(data.amount),
        note: data.note,
        requestId: data.requestId,
        createdById: ctx.user.id,
      },
    });
    await writeAudit(tx, ctx.user, {
      action: "POST",
      entityType: "CashEntry",
      entityId: entry.id,
      newValue: entry,
      requestId: data.requestId,
    });
    return entry;
  });
}

/** Cancels a cash book entry with a reason; it stays in the list, crossed out. */
export async function reverseCashEntry(ctx: ServiceCtx, input: unknown) {
  assertCan(ctx.user.role, "payments.manage");
  const { id, reason } = reverseSchema.parse(input);
  await ctx.db.$transaction(async (tx) => {
    const entry = found(await tx.cashEntry.findUnique({ where: { id } }), "cash entry");
    const done = await tx.cashEntry.updateMany({
      where: { id, status: "POSTED" },
      data: { status: "REVERSED", reversedAt: new Date(), reversalReason: reason },
    });
    if (done.count === 0) throw new ServiceError("This entry is already cancelled.");
    await writeAudit(tx, ctx.user, {
      action: "REVERSE",
      entityType: "CashEntry",
      entityId: id,
      oldValue: { status: "POSTED", kind: entry.kind, amount: entry.amount },
      newValue: { status: "REVERSED", reason },
    });
  });
}

/**
 * Saves the cash counted at the end of a day (a recount replaces it). With `correct`, a shortage
 * or extra is posted as a count difference so the book matches the drawer. Returns the
 * difference against the book (counted − book) before any correction.
 */
export async function saveCashCount(ctx: ServiceCtx, input: unknown) {
  assertCan(ctx.user.role, "payments.manage");
  const data = cashCountSchema.parse(input);
  if (data.countDate > businessToday()) throw new ServiceError("The date cannot be after today.");
  return ctx.db.$transaction(async (tx) => {
    const { opening, days } = await computeCashBook(tx, data.countDate, data.countDate);
    if (opening && data.countDate < opening.entryDate)
      throw new ServiceError("This day is before the opening cash. Count a later day.");
    const expected = days[0]?.closing ?? ZERO;
    const counted = D(data.counted);
    const before = await tx.cashCount.findUnique({
      where: { tenantId_countDate: { tenantId: ctx.user.tenantId, countDate: data.countDate } },
    });
    const saved = await tx.cashCount.upsert({
      where: { tenantId_countDate: { tenantId: ctx.user.tenantId, countDate: data.countDate } },
      create: {
        tenantId: ctx.user.tenantId,
        countDate: data.countDate,
        counted,
        expected,
        note: data.note,
        createdById: ctx.user.id,
      },
      update: { counted, expected, note: data.note, createdById: ctx.user.id },
    });
    await writeAudit(tx, ctx.user, {
      action: before ? "UPDATE" : "CREATE",
      entityType: "CashCount",
      entityId: saved.id,
      oldValue: before ? { counted: before.counted, expected: before.expected } : undefined,
      newValue: { countDate: saved.countDate, counted, expected, correct: data.correct },
    });
    const difference = counted.sub(expected);
    if (data.correct && !difference.isZero()) {
      const entry = await tx.cashEntry.create({
        data: {
          tenantId: ctx.user.tenantId,
          number: await nextDocumentNumber(tx, ctx, "CASH_ENTRY"),
          entryDate: data.countDate,
          kind: "COUNT_DIFFERENCE",
          direction: difference.gt(0) ? "IN" : "OUT",
          amount: difference.abs(),
          note: data.note ?? (difference.gt(0) ? "Extra cash at count" : "Cash short at count"),
          createdById: ctx.user.id,
        },
      });
      await writeAudit(tx, ctx.user, {
        action: "POST",
        entityType: "CashEntry",
        entityId: entry.id,
        newValue: entry,
      });
    }
    return { expected, counted, difference, corrected: data.correct && !difference.isZero() };
  });
}
