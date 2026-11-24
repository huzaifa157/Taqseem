import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { businessToday } from "@/lib/dates";
import {
  filterParam,
  icontains,
  type ListParams,
  matchEveryWord,
  phoneContains,
  statusWhere,
} from "@/lib/list-params";
import { CUSTOMER_TYPES, type CustomerInput, customerSchema } from "@/lib/validation/master";

import { writeAudit } from "../../audit";
import { assertCan } from "../../auth/permissions";
import type { TenantTx } from "../../db/tenant";
import { ServiceError } from "../errors";
import { changedFields, PAGE_SIZE, paged, type ServiceCtx, withUniqueMessage } from "./common";
import { customerBalances, getOpeningBalance, setOpeningBalance } from "./opening-balances";

/** The customer list's search and filters (also used by the export). */
function customerWhere(
  params: Pick<ListParams, "q" | "status">,
  filters: Record<string, unknown>,
): Prisma.CustomerWhereInput {
  const areaId = filterParam(filters, "areaId");
  const type = filterParam(filters, "type");
  return {
    ...statusWhere(params.status),
    ...matchEveryWord(params.q, (w): Prisma.CustomerWhereInput[] => [
      ...["name", "shopName", "address"].map((field) => ({ [field]: icontains(w) })),
      { phone: phoneContains(w) },
      { whatsapp: phoneContains(w) },
      { area: { name: icontains(w) } },
    ]),
    ...(areaId ? { areaId } : {}),
    ...(type && (CUSTOMER_TYPES as readonly string[]).includes(type)
      ? { type: type as (typeof CUSTOMER_TYPES)[number] }
      : {}),
  };
}

/** Customer list with each customer's current pending balance (everyone can see it: order entry). */
export async function listCustomers(
  ctx: ServiceCtx,
  params: ListParams,
  filters: Record<string, unknown> = {},
) {
  const where = customerWhere(params, filters);
  const [rows, total] = await Promise.all([
    ctx.db.customer.findMany({
      where,
      orderBy: [{ area: { sortOrder: "asc" } }, { routeSequence: "asc" }, { name: "asc" }],
      skip: (params.page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { area: { select: { name: true } } },
    }),
    ctx.db.customer.count({ where }),
  ]);
  const balances = await customerBalances(
    ctx.db,
    rows.map((r) => r.id),
  );
  return paged(
    rows.map((row) => ({ ...row, balance: balances.get(row.id)?.toFixed(2) ?? "0.00" })),
    total,
    params.page,
  );
}

/**
 * Every customer the list's search and filters match, in list order, with the area's warehouse:
 * the rows of the customer export, which the customer import of another Taqseem reads. No
 * balances: money is not moved between installations.
 */
export async function exportCustomers(
  ctx: ServiceCtx,
  params: Pick<ListParams, "q" | "status">,
  filters: Record<string, unknown> = {},
) {
  assertCan(ctx.user.role, "masterData.manage");
  return ctx.db.customer.findMany({
    where: customerWhere(params, filters),
    orderBy: [{ area: { sortOrder: "asc" } }, { routeSequence: "asc" }, { name: "asc" }],
    include: { area: { select: { name: true, warehouse: { select: { name: true } } } } },
  });
}

export async function getCustomer(ctx: ServiceCtx, id: string) {
  assertCan(ctx.user.role, "masterData.manage");
  const row = await ctx.db.customer.findUnique({
    where: { id },
    include: { area: { select: { name: true, warehouse: { select: { name: true } } } } },
  });
  if (!row) throw new ServiceError("This customer was not found.");
  const opening = await getOpeningBalance(ctx.db, { kind: "CUSTOMER", customerId: id });
  return { ...row, openingBalance: opening.toFixed(2) };
}

async function assertArea(tx: TenantTx, areaId: string | null) {
  if (!areaId) return;
  const area = await tx.area.findUnique({ where: { id: areaId } });
  if (!area || !area.isActive) throw new ServiceError("Choose an active area.");
}

/** Posts opening-balance changes per company; returns { companyId: { from, to } } for the audit log. */
/** Sets the customer's opening balance (undefined: leave it); returns the change, if any. */
async function applyOpeningBalance(
  tx: TenantTx,
  ctx: ServiceCtx,
  customerId: string,
  balance: string | undefined,
) {
  if (balance === undefined) return null;
  return setOpeningBalance(tx, ctx, { kind: "CUSTOMER", customerId }, balance, businessToday());
}

/** A customer name as stored: trimmed, single spaces. */
export const tidyCustomerName = (name: string) => name.trim().replace(/\s+/g, " ");

/**
 * Customer names are unique in a business, ignoring capitals and extra spaces ("Ali Traders" and
 * "ali  traders" are the same customer). The database has the same rule (an index on the
 * lower-cased, tidied name); this finds the clash first for a readable message.
 */
export async function customerWithName(tx: TenantTx, name: string, exceptId?: string) {
  return tx.customer.findFirst({
    where: {
      name: { equals: tidyCustomerName(name), mode: "insensitive" },
      ...(exceptId ? { NOT: { id: exceptId } } : {}),
    },
    select: { id: true, name: true, isActive: true },
    orderBy: { createdAt: "asc" },
  });
}

export function customerNameTaken(existing: { name: string; isActive: boolean }) {
  return `There is already a customer named “${existing.name}”${
    existing.isActive ? "" : " (inactive: reactivate them under Customers)"
  }. Customer names must be different; add the shop or area to tell them apart.`;
}

const NAME_TAKEN = "There is already a customer with this name. Customer names must be different.";

/** Creates a customer inside the caller's transaction (also used by the import). */
export async function createCustomerTx(
  tx: TenantTx,
  ctx: ServiceCtx,
  parsed: CustomerInput,
  requestId?: string,
) {
  const { requestId: _r, openingBalance, ...data } = parsed;
  if (requestId) {
    const existing = await tx.customer.findUnique({
      where: { tenantId_requestId: { tenantId: ctx.user.tenantId, requestId } },
    });
    if (existing) return existing;
  }
  data.name = tidyCustomerName(data.name);
  const taken = await customerWithName(tx, data.name);
  if (taken) throw new ServiceError(customerNameTaken(taken));
  await assertArea(tx, data.areaId);
  const created = await withUniqueMessage(NAME_TAKEN, () =>
    tx.customer.create({ data: { tenantId: ctx.user.tenantId, requestId, ...data } }),
  );
  const opening = await applyOpeningBalance(tx, ctx, created.id, openingBalance);
  await writeAudit(tx, ctx.user, {
    action: "CREATE",
    entityType: "Customer",
    entityId: created.id,
    newValue: { ...created, openingBalance: opening?.to ?? null },
    requestId,
  });
  return created;
}

export async function createCustomer(ctx: ServiceCtx, input: unknown) {
  assertCan(ctx.user.role, "masterData.manage");
  const parsed = customerSchema.parse(input);
  return ctx.db.$transaction((tx) => createCustomerTx(tx, ctx, parsed, parsed.requestId));
}

export async function updateCustomer(ctx: ServiceCtx, id: string, input: unknown) {
  assertCan(ctx.user.role, "masterData.manage");
  const { requestId: _ignored, openingBalance, ...data } = customerSchema.parse(input);
  return ctx.db.$transaction(async (tx) => {
    const before = await tx.customer.findUnique({ where: { id } });
    if (!before) throw new ServiceError("This customer was not found.");
    if (data.areaId !== before.areaId) await assertArea(tx, data.areaId);
    data.name = tidyCustomerName(data.name);
    const taken = await customerWithName(tx, data.name, id);
    if (taken) throw new ServiceError(customerNameTaken(taken));
    const after = await withUniqueMessage(NAME_TAKEN, () =>
      tx.customer.update({ where: { id }, data }),
    );
    const opening = await applyOpeningBalance(tx, ctx, id, openingBalance);
    const diff = changedFields(before, after);
    if (opening) {
      diff.oldValue.openingBalance = opening.from;
      diff.newValue.openingBalance = opening.to;
    }
    if (diff.changed || opening) {
      await writeAudit(tx, ctx.user, {
        action: "UPDATE",
        entityType: "Customer",
        entityId: id,
        oldValue: diff.oldValue,
        newValue: diff.newValue,
      });
    }
    return after;
  });
}

/** For the credit-limit display: null = no limit. */
export function creditLimitText(limit: Prisma.Decimal | null) {
  return limit === null ? "No limit" : limit.toFixed(2);
}
