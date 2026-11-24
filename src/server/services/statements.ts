import "server-only";

import { Prisma } from "@/generated/prisma/client";

import { assertCan } from "../auth/permissions";
import type { ServiceCtx } from "./master/common";
import { found } from "./posting";
import { LEDGER_TYPE_LABEL } from "./purchasing/company-ledger";
import type { DateRange } from "./purchasing/filters";

// Customer statement: every bill, payment and adjustment on the customer's one account, with a
// running balance of what they owe. Printed and handed or sent to the customer.

const D = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v);

export async function getCustomerStatement(ctx: ServiceCtx, customerId: string, opts: DateRange) {
  assertCan(ctx.user.role, "ledgers.view");
  const customer = found(
    await ctx.db.customer.findUnique({
      where: { id: customerId },
      include: { area: { select: { name: true } } },
    }),
    "customer",
  );
  // One account per customer: every entry, whatever company older entries were posted with.
  const base = { partyType: "CUSTOMER" as const, customerId };

  const before = opts.from
    ? await ctx.db.ledgerEntry.aggregate({
        where: { ...base, entryDate: { lt: opts.from } },
        _sum: { debit: true, credit: true },
      })
    : null;
  const opening = before ? D(before._sum.debit ?? 0).sub(before._sum.credit ?? 0) : D(0);

  const entries = await ctx.db.ledgerEntry.findMany({
    where: {
      ...base,
      ...(opts.from || opts.to
        ? {
            entryDate: {
              ...(opts.from ? { gte: opts.from } : {}),
              ...(opts.to ? { lte: opts.to } : {}),
            },
          }
        : {}),
    },
    orderBy: [{ entryDate: "asc" }, { createdAt: "asc" }],
  });

  // Entries posted before customers had one account were split per company (a bill or payment
  // in several rows): those rows show as one.
  type Row = {
    id: string;
    key: string;
    entryDate: Date;
    typeLabel: string;
    description: string;
    debit: Prisma.Decimal;
    credit: Prisma.Decimal;
    balance: Prisma.Decimal;
  };
  const rows: Row[] = [];
  let balance = opening;
  for (const e of entries) {
    balance = balance.add(e.debit).sub(e.credit);
    const key = e.referenceId
      ? `${e.type}|${e.referenceType}|${e.referenceId}|${e.entryDate.toISOString()}|${e.description}`
      : e.id;
    const last = rows.at(-1);
    if (last && last.key === key) {
      last.debit = last.debit.add(e.debit);
      last.credit = last.credit.add(e.credit);
      last.balance = balance;
      continue;
    }
    rows.push({
      id: e.id,
      key,
      entryDate: e.entryDate,
      typeLabel: LEDGER_TYPE_LABEL[e.type],
      description: e.description ?? "",
      debit: e.debit,
      credit: e.credit,
      balance,
    });
  }

  return {
    customer: {
      id: customer.id,
      name: customer.name,
      shopName: customer.shopName,
      phone: customer.phone,
      address: customer.address,
      areaName: customer.area?.name ?? null,
    },
    range: { from: opts.from, to: opts.to },
    opening,
    rows: rows.map(({ key: _key, ...r }) => r),
    closing: balance,
  };
}

export type CustomerStatement = Awaited<ReturnType<typeof getCustomerStatement>>;
