import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { calculateLineAmounts } from "@/lib/pricing";
import { formatDozens, PACKETS_PER_DOZEN } from "@/lib/units";

import { assertCan, can } from "../../auth/permissions";
import { cashDay } from "../cash-book";
import type { ServiceCtx } from "../master/common";

// Daily summary (SPEC §10 "Daily summary"): the numbers to check at day-end, for one business
// date. Everyone with operations access sees deliveries, products sold and stock. Money
// (collections, pending, expenses, company payments, cash in hand) needs payments.manage. Cost,
// gross profit and net profit need financials.view; staff never see them (CLAUDE.md rule 8).
//
// "Sold" means billed to customers on that date: posted bills (billDate = the trip date), at their
// latest revision, so returns and damage entered at day-end are already taken off.

const D = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v);
const ZERO = D(0);
const DAY_MS = 86_400_000;
/** Business days are Pakistan days (UTC+5, no daylight saving): audit times are compared so. */
const PK_OFFSET_MS = 5 * 3_600_000;

type SnapshotLine = {
  productId: string;
  companyId: string;
  quantity: number;
  netAmount: string;
};

const sum = <T>(rows: T[], f: (r: T) => Prisma.Decimal | null | undefined) =>
  rows.reduce((s, r) => s.add(f(r) ?? ZERO), ZERO);

export async function dailyReport(ctx: ServiceCtx, date: Date) {
  assertCan(ctx.user.role, "reports.view");
  const showMoney = can(ctx.user.role, "payments.manage");
  const showCost = can(ctx.user.role, "financials.view");
  const next = new Date(date.getTime() + DAY_MS);

  // ── Deliveries and products sold ──
  const [orders, products, companies] = await Promise.all([
    ctx.db.salesOrder.findMany({
      where: { bill: { billDate: date, postedAt: { not: null }, status: "POSTED" } },
      select: {
        id: true,
        number: true,
        status: true,
        fulfilment: true,
        createdById: true,
        customer: { select: { name: true } },
        lines: {
          select: {
            productId: true,
            quantity: true,
            rate: true,
            standardRate: true,
            rateNote: true,
            returnedQuantity: true,
            damagedQuantity: true,
          },
        },
        bill: {
          select: {
            netAmount: true,
            revisions: { orderBy: { revision: "desc" }, take: 1, select: { lines: true } },
          },
        },
      },
    }),
    ctx.db.product.findMany({
      select: {
        id: true,
        code: true,
        name: true,
        companyId: true,
        purchaseRate: true,
        minStockLevel: true,
      },
    }),
    ctx.db.company.findMany({ select: { id: true, name: true } }),
  ]);
  const productById = new Map(products.map((p) => [p.id, p]));
  const companyName = new Map(companies.map((c) => [c.id, c.name]));

  const sold = new Map<string, { quantity: number; amount: Prisma.Decimal }>();
  for (const o of orders) {
    for (const l of (o.bill?.revisions[0]?.lines ?? []) as SnapshotLine[]) {
      const s = sold.get(l.productId) ?? { quantity: 0, amount: ZERO };
      sold.set(l.productId, {
        quantity: s.quantity + l.quantity,
        amount: s.amount.add(l.netAmount),
      });
    }
  }
  const productsSold = [...sold]
    .map(([productId, s]) => {
      const p = productById.get(productId)!;
      // Cost at today's purchase rate (batches keep no cost of their own yet).
      const cost = showCost
        ? calculateLineAmounts({
            quantity: s.quantity,
            baseUnitsPerPriceUnit: PACKETS_PER_DOZEN,
            rate: p.purchaseRate,
          }).netAmount
        : null;
      return {
        productId,
        code: p.code,
        name: p.name,
        companyName: companyName.get(p.companyId) ?? "",
        quantity: s.quantity,
        amount: s.amount,
        cost: cost ? D(cost.toString()) : null,
        profit: cost ? s.amount.sub(cost.toString()) : null,
      };
    })
    .sort((a, b) => a.companyName.localeCompare(b.companyName) || a.code.localeCompare(b.code));

  const kept = (l: { quantity: number; returnedQuantity: number; damagedQuantity: number }) =>
    l.quantity - l.returnedQuantity - l.damagedQuantity;
  // Deliveries only: counter sales are collected at the warehouse (no trip, no day-end).
  const deliveryOrders = orders.filter((o) => o.fulfilment === "DELIVERY");
  const counterOrders = orders.filter((o) => o.fulfilment === "COUNTER");
  const reconciled = deliveryOrders.filter((o) => o.status !== "DISPATCHED");
  const deliveries = {
    orders: deliveryOrders.length,
    delivered: deliveryOrders.filter((o) => o.status === "DELIVERED").length,
    partly: deliveryOrders.filter((o) => o.status === "PARTIALLY_DELIVERED").length,
    returned: deliveryOrders.filter((o) => o.status === "RETURNED").length,
    stillOut: deliveryOrders.filter((o) => o.status === "DISPATCHED").length,
    sent: deliveryOrders.flatMap((o) => o.lines).reduce((s, l) => s + l.quantity, 0),
    kept: reconciled.flatMap((o) => o.lines).reduce((s, l) => s + kept(l), 0),
    returnedQty: deliveryOrders.flatMap((o) => o.lines).reduce((s, l) => s + l.returnedQuantity, 0),
    damagedQty: deliveryOrders.flatMap((o) => o.lines).reduce((s, l) => s + l.damagedQuantity, 0),
    billed: sum(deliveryOrders, (o) => o.bill?.netAmount),
    list: orders
      .map((o) => ({
        id: o.id,
        number: o.number,
        customerName: o.customer.name,
        status: o.status,
        amount: o.bill?.netAmount ?? ZERO,
        counter: o.fulfilment === "COUNTER",
      }))
      .sort((a, b) => a.number - b.number),
  };

  // ── Stock: each product's movements on the day and what is left at its end ──
  const [moves, before] = await Promise.all([
    ctx.db.stockMovement.groupBy({
      by: ["productId", "type", "bucket"],
      where: { occurredAt: { gte: date, lt: next } },
      _sum: { quantity: true },
    }),
    ctx.db.stockMovement.groupBy({
      by: ["productId", "bucket"],
      where: { occurredAt: { lt: date } },
      _sum: { quantity: true },
    }),
  ]);
  const stock = products
    .map((p) => {
      const opening =
        before.find((b) => b.productId === p.id && b.bucket === "SALEABLE")?._sum.quantity ?? 0;
      const day = moves.filter((m) => m.productId === p.id);
      const of = (type: string, bucket = "SALEABLE") =>
        day.find((m) => m.type === type && m.bucket === bucket)?._sum.quantity ?? 0;
      const received = of("GOODS_RECEIPT") + of("OPENING");
      // Out to customers: sales, and goods given in exchange for damage.
      const dispatched = -of("DISPATCH") - of("DAMAGE_REPLACEMENT");
      const returned = of("CUSTOMER_RETURN");
      const closing =
        opening +
        day.filter((m) => m.bucket === "SALEABLE").reduce((s, m) => s + (m._sum.quantity ?? 0), 0);
      // Adjustments, reversals and anything else that moved saleable stock.
      const adjusted = closing - opening - received + dispatched - returned;
      const damagedNow =
        (before.find((b) => b.productId === p.id && b.bucket === "DAMAGED")?._sum.quantity ?? 0) +
        day.filter((m) => m.bucket === "DAMAGED").reduce((s, m) => s + (m._sum.quantity ?? 0), 0);
      return {
        productId: p.id,
        code: p.code,
        name: p.name,
        companyName: companyName.get(p.companyId) ?? "",
        opening,
        received,
        dispatched,
        returned,
        adjusted,
        closing,
        damaged: damagedNow,
        low: p.minStockLevel > 0 && closing < p.minStockLevel,
      };
    })
    .filter(
      (r) =>
        r.opening ||
        r.closing ||
        r.received ||
        r.dispatched ||
        r.returned ||
        r.adjusted ||
        r.damaged,
    )
    .sort((a, b) => a.companyName.localeCompare(b.companyName) || a.code.localeCompare(b.code));

  const money = showMoney ? await moneyFor(ctx, date, next) : null;

  // ── Each bill: what it came to (after the special discount) and its cost of goods ──
  const costOfLines = (lines: SnapshotLine[]) =>
    lines.reduce(
      (s, l) =>
        s.add(
          calculateLineAmounts({
            quantity: l.quantity,
            baseUnitsPerPriceUnit: PACKETS_PER_DOZEN,
            rate: productById.get(l.productId)?.purchaseRate ?? 0,
          }).netAmount.toString(),
        ),
      ZERO,
    );
  const billOf = (o: (typeof orders)[number]) => {
    const lines = (o.bill?.revisions[0]?.lines ?? []) as SnapshotLine[];
    const sales = o.bill?.netAmount ?? ZERO;
    const cost = showCost ? costOfLines(lines) : null;
    return {
      sales,
      quantity: lines.reduce((s, l) => s + l.quantity, 0),
      items: lines.length,
      cost,
      profit: cost ? sales.sub(cost) : null,
    };
  };
  const totalsOf = (list: typeof orders) => {
    const bills = list.map(billOf);
    const sales = bills.reduce((s, b) => s.add(b.sales), ZERO);
    const cost = showCost ? bills.reduce((s, b) => s.add(b.cost!), ZERO) : null;
    return { sales, cost, gross: cost ? sales.sub(cost) : null };
  };

  // ── Counter sales on their own: each sale, what was paid at the counter, and its profit ──
  const paidAtCounter = counterOrders.length
    ? await ctx.db.customerPayment.groupBy({
        by: ["salesOrderId"],
        where: { salesOrderId: { in: counterOrders.map((o) => o.id) }, status: "POSTED" },
        _sum: { amount: true },
      })
    : [];
  const paidOf = new Map(paidAtCounter.map((g) => [g.salesOrderId!, g._sum.amount ?? ZERO]));
  const counterList = counterOrders
    .map((o) => {
      const b = billOf(o);
      const paid = paidOf.get(o.id) ?? ZERO;
      return {
        id: o.id,
        number: o.number,
        customerName: o.customer.name,
        ...b,
        paid,
        onAccount: Prisma.Decimal.max(b.sales.sub(paid), 0),
      };
    })
    .sort((a, b) => a.number - b.number);
  const counterTotals = totalsOf(counterOrders);
  const counter = {
    sales: counterOrders.length,
    billed: counterTotals.sales,
    quantity: counterList.reduce((s, o) => s + o.quantity, 0),
    paid: counterList.reduce((s, o) => s.add(o.paid), ZERO),
    onAccount: counterList.reduce((s, o) => s.add(o.onAccount), ZERO),
    cost: counterTotals.cost,
    profit: counterTotals.gross,
    list: counterList,
  };

  // ── Profit (owner / accountant): sales − cost of goods sold − expenses ──
  // Sales are what the bills came to (after any special discount), split delivery / counter.
  const deliveryTotals = totalsOf(deliveryOrders);
  const salesTotal = deliveryTotals.sales.add(counterTotals.sales);
  const costTotal = showCost ? sum(productsSold, (p) => p.cost) : null;
  const profit =
    showCost && costTotal && money
      ? {
          sales: salesTotal,
          cost: costTotal,
          gross: salesTotal.sub(costTotal),
          // Paid for companies comes back on their bills: not our cost. Monthly costs count as
          // the day's share.
          expenses: money.expenses.forProfit,
          net: salesTotal.sub(costTotal).sub(money.expenses.forProfit),
          delivery: deliveryTotals,
          counter: counterTotals,
        }
      : null;

  // Lines billed this day at a rate changed on the order (anyone may change it; the owner sees
  // them here). Difference = (changed − normal rate) × dozens, negative when sold for less.
  const byUser = new Map(
    (
      await ctx.db.user.findMany({
        where: { id: { in: [...new Set(orders.map((o) => o.createdById!).filter(Boolean))] } },
        select: { id: true, name: true },
      })
    ).map((u) => [u.id, u.name]),
  );
  const specialRates = orders
    .flatMap((o) =>
      o.lines
        .filter((l) => l.standardRate)
        .map((l) => {
          const p = productById.get(l.productId)!;
          return {
            orderId: o.id,
            number: o.number,
            counter: o.fulfilment === "COUNTER",
            customerName: o.customer.name,
            code: p.code,
            productName: p.name,
            quantity: l.quantity,
            standardRate: l.standardRate!,
            rate: l.rate,
            difference: l.rate
              .sub(l.standardRate!)
              .mul(l.quantity)
              .div(PACKETS_PER_DOZEN)
              .toDecimalPlaces(2),
            note: l.rateNote,
            by: o.createdById ? (byUser.get(o.createdById) ?? null) : null,
          };
        }),
    )
    .sort((a, b) => a.number - b.number);

  const discountChanges = await discountChangesOn(ctx, date);

  const issues = dayIssues({
    specialRates,
    discountChanges: discountChanges.length,
    date,
    stillOut: deliveries.stillOut,
    orders,
    productById,
    productsSold,
    stock,
    money,
    showCost,
  });

  return {
    date,
    showMoney,
    showCost,
    issues,
    deliveries,
    specialRates,
    discountChanges,
    /** Counter sales billed on the day (collected at the warehouse), each with its profit. */
    counter,
    productsSold,
    soldTotals: {
      quantity: productsSold.reduce((s, p) => s + p.quantity, 0),
      amount: salesTotal,
      cost: costTotal,
    },
    stock,
    money,
    profit,
  };
}

async function moneyFor(ctx: ServiceCtx, date: Date, next: Date) {
  const [
    payments,
    bounced,
    expenses,
    categories,
    companyPayments,
    receipts,
    pendingRows,
    customers,
  ] = await Promise.all([
    ctx.db.customerPayment.groupBy({
      by: ["method", "collectedVia"],
      where: { paymentDate: date, status: "POSTED" },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    ctx.db.ledgerEntry.aggregate({
      where: { partyType: "CUSTOMER", type: "CHEQUE_BOUNCE", entryDate: date },
      _sum: { debit: true },
      _count: { _all: true },
    }),
    ctx.db.expense.groupBy({
      by: ["categoryId", "method", "companyId", "spreadOverMonth"],
      where: { expenseDate: date, status: "POSTED" },
      _sum: { amount: true },
    }),
    ctx.db.expenseCategory.findMany({ select: { id: true, name: true } }),
    ctx.db.companyPayment.groupBy({
      by: ["method"],
      where: { paymentDate: date, status: "POSTED" },
      _sum: { amount: true },
    }),
    ctx.db.goodsReceipt.findMany({
      where: { receivedDate: date, status: "POSTED" },
      select: {
        number: true,
        company: { select: { name: true } },
        lines: { select: { quantity: true, amount: true } },
      },
    }),
    // What each customer owes at the end of the day.
    ctx.db.ledgerEntry.groupBy({
      by: ["customerId"],
      where: { partyType: "CUSTOMER", entryDate: { lt: next } },
      _sum: { debit: true, credit: true },
    }),
    ctx.db.customer.findMany({
      select: {
        id: true,
        name: true,
        shopName: true,
        phone: true,
        whatsapp: true,
        creditLimit: true,
      },
    }),
  ]);

  const collected = (filter: (g: (typeof payments)[number]) => boolean) =>
    sum(payments.filter(filter), (g) => g._sum.amount);
  const byMethod = (m: string) => ({
    atDelivery: collected((g) => g.method === m && g.collectedVia === "DELIVERY"),
    atOffice: collected((g) => g.method === m && g.collectedVia === "OFFICE"),
    total: collected((g) => g.method === m),
  });
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  const expenseByCategory = new Map<string, Prisma.Decimal>();
  for (const e of expenses) {
    const name = catName.get(e.categoryId) ?? "";
    expenseByCategory.set(name, (expenseByCategory.get(name) ?? ZERO).add(e._sum.amount ?? ZERO));
  }
  const cashExpenses = sum(
    expenses.filter((e) => e.method === "CASH"),
    (e) => e._sum.amount,
  );
  // Monthly costs paid at once (rent, salary): profit counts a share each day of their month.
  const monthStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  const daysInMonth = monthEnd.getUTCDate();
  const monthly = await ctx.db.expense.aggregate({
    where: {
      spreadOverMonth: true,
      status: "POSTED",
      expenseDate: { gte: monthStart, lte: monthEnd },
    },
    _sum: { amount: true },
  });
  const monthlyTotal = monthly._sum.amount ?? ZERO;
  const dailyShare = monthlyTotal.div(daysInMonth).toDecimalPlaces(2);
  const spreadPaidToday = sum(
    expenses.filter((e) => e.spreadOverMonth),
    (e) => e._sum.amount,
  );
  const expenseTotal = sum(expenses, (e) => e._sum.amount);
  const forCompanies = sum(
    expenses.filter((e) => e.companyId),
    (e) => e._sum.amount,
  );
  const cashToCompanies = sum(
    companyPayments.filter((p) => p.method === "CASH"),
    (p) => p._sum.amount,
  );
  const cash = byMethod("CASH");
  // The cash book's day: opening (the day before's closing), cash put in or taken out, closing,
  // and the night's count.
  const book = await cashDay(ctx.db, date);

  const customerById = new Map(customers.map((c) => [c.id, c]));
  const owing = pendingRows
    .map((g) => {
      const c = customerById.get(g.customerId!)!;
      const balance = D(g._sum.debit ?? 0).sub(g._sum.credit ?? 0);
      return {
        customerId: g.customerId!,
        name: c.name,
        shopName: c.shopName,
        phone: c.phone,
        whatsapp: c.whatsapp,
        balance,
        overLimit: c.creditLimit !== null && balance.gt(c.creditLimit),
      };
    })
    .filter((c) => c.balance.gt(0))
    .sort((a, b) => b.balance.comparedTo(a.balance));

  return {
    collections: {
      cash,
      cheque: byMethod("CHEQUE"),
      online: byMethod("ONLINE"),
      total: collected(() => true),
      count: payments.reduce((s, g) => s + g._count._all, 0),
    },
    bounced: { amount: bounced._sum.debit ?? ZERO, count: bounced._count._all },
    expenses: {
      byCategory: [...expenseByCategory]
        .map(([name, amount]) => ({ name, amount }))
        .sort((a, b) => b.amount.comparedTo(a.amount)),
      total: expenseTotal,
      /** Of the total, paid for companies that pay it back (not our cost: left out of profit). */
      forCompanies,
      /** Monthly costs (rent, salary) this month, and the share counted in each day's profit. */
      monthly: { total: monthlyTotal, dailyShare, days: daysInMonth, paidToday: spreadPaidToday },
      /**
       * What the day's profit counts: our own expenses of the day, except monthly costs paid
       * today, plus the day's share of this month's monthly costs.
       */
      forProfit: expenseTotal.sub(forCompanies).sub(spreadPaidToday).add(dailyShare),
    },
    companyPayments: sum(companyPayments, (p) => p._sum.amount),
    goodsReceived: receipts.map((r) => ({
      number: r.number,
      companyName: r.company.name,
      quantity: r.lines.reduce((s, l) => s + l.quantity, 0),
      amount: sum(r.lines, (l) => l.amount),
    })),
    // Cash in: collected in cash. Cash out: cash expenses and cash paid to companies.
    cashInHand: {
      in: cash.total,
      expenses: cashExpenses,
      toCompanies: cashToCompanies,
      net: cash.total.sub(cashExpenses).sub(cashToCompanies),
      /** From the cash book; null for a day before the opening cash. */
      book: book.day
        ? {
            hasOpening: book.hasOpening,
            opening: book.day.opening,
            added: book.day.added,
            taken: book.day.taken,
            closing: book.day.closing,
            count: book.day.count,
          }
        : null,
    },
    pending: {
      total: sum(owing, (c) => c.balance),
      customers: owing.length,
      overLimit: owing.filter((c) => c.overLimit).length,
      top: owing.slice(0, 15),
      overLimitList: owing.filter((c) => c.overLimit),
    },
  };
}

/**
 * Customers' own discounts set, changed or removed on the day (from orders and counter sales), from
 * the audit log: who, which product, from what to what, and on which order.
 */
/** An amount from the audit log ("48") as money text ("48.00"), or null. */
const amount = (v: string | undefined) => (v === undefined ? null : D(v).toFixed(2));

async function discountChangesOn(ctx: ServiceCtx, date: Date) {
  const from = new Date(date.getTime() - PK_OFFSET_MS);
  const rows = await ctx.db.auditLog.findMany({
    where: {
      entityType: "CustomerProductDiscount",
      createdAt: { gte: from, lt: new Date(from.getTime() + DAY_MS) },
    },
    orderBy: { createdAt: "asc" },
    select: { action: true, userId: true, oldValue: true, newValue: true, createdAt: true },
  });
  if (rows.length === 0) return [];
  type Value = {
    customerId?: string;
    productId?: string;
    discountPerDozen?: string;
    orderId?: string;
  };
  const parsed = rows.map((r) => ({
    ...r,
    old: (r.oldValue ?? null) as Value | null,
    now: (r.newValue ?? null) as Value | null,
  }));
  const ids = (f: (v: Value) => string | undefined) =>
    [
      ...new Set(parsed.flatMap((r) => [r.old, r.now].filter((v) => v !== null).map((v) => f(v!)))),
    ].filter((v): v is string => Boolean(v));
  const [customers, products, orders, users] = await Promise.all([
    ctx.db.customer.findMany({
      where: { id: { in: ids((v) => v.customerId) } },
      select: { id: true, name: true },
    }),
    ctx.db.product.findMany({
      where: { id: { in: ids((v) => v.productId) } },
      select: { id: true, code: true, name: true },
    }),
    ctx.db.salesOrder.findMany({
      where: { id: { in: ids((v) => v.orderId) } },
      select: { id: true, number: true },
    }),
    ctx.db.user.findMany({
      where: { id: { in: [...new Set(parsed.map((r) => r.userId).filter((u) => u !== null))] } },
      select: { id: true, name: true },
    }),
  ]);
  const name = new Map(customers.map((c) => [c.id, c.name]));
  const product = new Map(products.map((p) => [p.id, p]));
  const order = new Map(orders.map((o) => [o.id, o.number]));
  const user = new Map(users.map((u) => [u.id, u.name]));
  return parsed.map((r) => {
    const v = r.now ?? r.old ?? {};
    const p = v.productId ? product.get(v.productId) : undefined;
    return {
      at: r.createdAt,
      customerName: (v.customerId && name.get(v.customerId)) || "—",
      product: p ? `${p.code} ${p.name}` : "—",
      before: amount(r.old?.discountPerDozen),
      after: amount(r.now?.discountPerDozen),
      orderId: r.now?.orderId ?? null,
      orderNumber: r.now?.orderId ? (order.get(r.now.orderId) ?? null) : null,
      by: r.userId ? (user.get(r.userId) ?? null) : null,
    };
  });
}

export type DailyReport = Awaited<ReturnType<typeof dailyReport>>;

export type DayIssue = {
  /** problem: something is wrong or unfinished; warning: worth a look. */
  level: "problem" | "warning";
  text: string;
  /** Where to fix it. */
  href: string;
};

const names = (list: string[], max = 3) =>
  list.length <= max
    ? list.join(", ")
    : `${list.slice(0, max).join(", ")} and ${list.length - max} more`;

/**
 * What needs attention on the day, worst first: the top of the daily report, so problems are not
 * lost in its tables.
 */
function dayIssues(d: {
  specialRates: { difference: Prisma.Decimal; number: number }[];
  discountChanges: number;
  date: Date;
  stillOut: number;
  orders: {
    lines: {
      productId: string;
      quantity: number;
      returnedQuantity: number;
      damagedQuantity: number;
    }[];
  }[];
  productById: Map<string, { code: string; name: string }>;
  productsSold: { code: string; profit: Prisma.Decimal | null }[];
  stock: { code: string; closing: number; low: boolean }[];
  money: Awaited<ReturnType<typeof moneyFor>> | null;
  showCost: boolean;
}): DayIssue[] {
  const day = d.date.toISOString().slice(0, 10);
  const issues: DayIssue[] = [];
  const add = (level: DayIssue["level"], text: string, href: string) =>
    issues.push({ level, text, href });

  if (d.stillOut)
    add(
      "problem",
      `${d.stillOut} order${d.stillOut === 1 ? "" : "s"} sent out this day ${d.stillOut === 1 ? "has" : "have"} no day-end entered: returns, damage and cash are not in yet.`,
      `/delivery?tripStatus=DISPATCHED&from=${day}&to=${day}`,
    );
  if (d.specialRates.length) {
    const bills = new Set(d.specialRates.map((r) => r.number)).size;
    const less = d.specialRates.reduce((s, r) => s.add(r.difference), ZERO);
    add(
      "warning",
      `${bills} bill${bills === 1 ? "" : "s"} had a changed rate (${d.specialRates.length} line${d.specialRates.length === 1 ? "" : "s"}${less.lt(0) ? `, ${less.abs().toFixed(2)} less than normal rates` : ""}). See "Rates changed on bills".`,
      "#special-rates",
    );
  }
  if (d.discountChanges)
    add(
      "warning",
      `${d.discountChanges} customer discount${d.discountChanges === 1 ? " was" : "s were"} set or changed. See "Customer discounts changed".`,
      "#discount-changes",
    );
  if (d.money?.bounced.count)
    add(
      "problem",
      `${d.money.bounced.count} cheque${d.money.bounced.count === 1 ? "" : "s"} bounced: ${d.money.bounced.amount.toFixed(2)} is owed again.`,
      "/payments?cheque=BOUNCED",
    );
  const negative = d.stock.filter((s) => s.closing < 0);
  if (negative.length)
    add(
      "problem",
      `Stock below zero for ${names(negative.map((s) => s.code))}: sold before the purchase was entered. Enter the purchase (or check the count).`,
      "/purchases/new",
    );
  const book = d.money?.cashInHand.book;
  if (book?.hasOpening ? book.closing.lt(0) : d.money && d.money.cashInHand.net.lt(0))
    add(
      "problem",
      book?.hasOpening
        ? `The cash book is below zero at the end of the day (${book.closing.toFixed(2)}). Check the expenses, company payments and cash entries.`
        : `More cash went out than came in (${d.money!.cashInHand.net.toFixed(2)}). Check the expenses and company payments.`,
      book?.hasOpening ? `/cash?from=${day}&to=${day}` : `/expenses?from=${day}&to=${day}`,
    );
  if (book?.count && !book.count.difference.isZero())
    add(
      "warning",
      `The cash counted was ${book.count.difference.abs().toFixed(2)} ${book.count.difference.lt(0) ? "short of" : "more than"} the cash book.`,
      `/cash?from=${day}&to=${day}`,
    );

  if (d.money?.pending.overLimitList.length)
    add(
      "warning",
      `${d.money.pending.overLimitList.length} customer${d.money.pending.overLimitList.length === 1 ? " is" : "s are"} over their credit limit: ${names(d.money.pending.overLimitList.map((c) => c.name))}.`,
      "/dashboard",
    );
  const low = d.stock.filter((s) => s.low && s.closing >= 0);
  if (low.length)
    add(
      "warning",
      `${low.length} product${low.length === 1 ? " is" : "s are"} below minimum stock: ${names(low.map((s) => s.code))}.`,
      "/inventory?level=low",
    );

  // High returns: 10% or more of what was sent, and at least half a dozen.
  const back = new Map<string, { sent: number; back: number; damaged: number }>();
  for (const o of d.orders)
    for (const l of o.lines) {
      const b = back.get(l.productId) ?? { sent: 0, back: 0, damaged: 0 };
      b.sent += l.quantity;
      b.back += l.returnedQuantity + l.damagedQuantity;
      b.damaged += l.damagedQuantity;
      back.set(l.productId, b);
    }
  const highReturns = [...back]
    .filter(([, b]) => b.sent > 0 && b.back >= 6 && b.back / b.sent >= 0.1)
    .map(
      ([id, b]) => `${d.productById.get(id)?.code ?? ""} ${Math.round((b.back / b.sent) * 100)}%`,
    );
  if (highReturns.length)
    add(
      "warning",
      `High returns or damage: ${names(highReturns, 4)} of what was sent came back.`,
      `/reports/damage?from=${day}&to=${day}`,
    );
  const damaged = [...back.values()].reduce((s, b) => s + b.damaged, 0);
  if (damaged)
    add(
      "warning",
      `${formatDozens(damaged)} damaged in delivery: settle the claims with the companies.`,
      d.money ? "/purchases/claims?claimStatus=AWAITING" : `/reports/damage?from=${day}&to=${day}`,
    );
  if (d.showCost) {
    const loss = d.productsSold.filter((p) => p.profit?.lt(0));
    if (loss.length)
      add(
        "warning",
        `Sold below cost: ${names(loss.map((p) => p.code))}. Check the sale rates and discounts.`,
        "/products",
      );
  }
  return issues.sort((a, b) => (a.level === b.level ? 0 : a.level === "problem" ? -1 : 1));
}
