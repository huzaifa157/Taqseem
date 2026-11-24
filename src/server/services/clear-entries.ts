import "server-only";

import pg from "pg";

import { writeAudit } from "../audit";
import { assertCan } from "../auth/permissions";
import { libpqUrl, SYNC_SCHEMA } from "../sync/engine";
import { ServiceError } from "./errors";
import type { ServiceCtx } from "./master/common";

// Settings → Clear entries (owner only): a one-time clean start before going live. Removes the
// trial orders, bills, purchases and stock and keeps the master data (companies, products,
// customers, areas, warehouses, bikes, staff, users, rates).
//
// This is the one approved exception to "posted entries are never deleted" (CLAUDE.md rule 2): the
// journals' append-only triggers are switched off inside this transaction only, and everything that
// refers to a cleared entry goes with it, so every balance that is left still adds up.
//
// Cleared:  sales orders, bills, bill revisions, customer returns, damage claims; purchase orders,
//           goods receipts, company bills, company payments; all stock movements, batches and
//           stock adjustments (opening stock too); customer payments taken with a cleared order
//           or put against a cleared bill; the ledger entries of all of these (and their
//           reversals); the document numbers of what is now empty, so they start again at 1.
// Kept:     master data, customer old balances (and payments that only settle them), opening
//           balances, delivery trips, expenses, the audit log.
//
// The cloud backup cannot replay the deletes (its journals are append-only too), so the next
// backup makes a fresh full copy instead (the website's agent does it within a minute).

export const CLEAR_CONFIRM_WORD = "CLEAR";

/** Ledger entries made by the documents cleared here (by `referenceType`). */
const CLEARED_LEDGER_REFERENCES = [
  "SalesOrder",
  "Bill",
  "CustomerReturn",
  "DamageReturn",
  "CompanyBill",
  "CompanyPayment",
  "CompanyClaim",
  "GoodsReceipt",
  "StockAdjustment",
];

/** Document numbers restarted at 1 once their table has no rows left for the business. */
const SEQUENCES: Record<string, string> = {
  SALES_ORDER: "SalesOrder",
  BILL: "Bill",
  PURCHASE_ORDER: "PurchaseOrder",
  GOODS_RECEIPT: "GoodsReceipt",
  COMPANY_BILL: "CompanyBill",
  COMPANY_PAYMENT: "CompanyPayment",
  COMPANY_CLAIM: "CompanyClaim",
  CUSTOMER_PAYMENT: "CustomerPayment",
  DAMAGE_RETURN: "DamageReturn",
};

/** Tables whose rows are deleted (their user triggers are off during the clear). */
const TOUCHED = [
  "CompanyClaim",
  "PaymentAllocation",
  "CustomerPayment",
  "LedgerEntry",
  "CustomerReturn",
  "DamageReturnLine",
  "DamageReturn",
  "BillRevision",
  "Bill",
  "SalesOrderLine",
  "SalesOrder",
  "CompanyPaymentAllocation",
  "CompanyPayment",
  "CompanyBill",
  "StockMovement",
  "Batch",
  "StockAdjustment",
  "GoodsReceiptLine",
  "GoodsReceipt",
  "PurchaseOrderLine",
  "PurchaseOrder",
  "Cheque",
  "DocumentSequence",
];

export type ClearCounts = {
  salesOrders: number;
  bills: number;
  customerPayments: number;
  goodsReceipts: number;
  companyBills: number;
  companyPayments: number;
  stockMovements: number;
};

const q = (name: string) => `"${name}"`;

async function withDb<T>(body: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client({ connectionString: libpqUrl(process.env.DATABASE_URL ?? "") });
  await db.connect();
  try {
    return await body(db);
  } finally {
    await db.end().catch(() => {});
  }
}

/** Customer payments that go with the cleared sales: taken with an order, or put against a bill. */
const CLEARED_PAYMENTS = `SELECT id FROM "CustomerPayment" p WHERE p."tenantId" = $1
  AND (p."salesOrderId" IS NOT NULL
    OR EXISTS (SELECT 1 FROM "PaymentAllocation" a
               WHERE a."tenantId" = $1 AND a."customerPaymentId" = p.id))`;

async function countAll(db: pg.Client, tenantId: string): Promise<ClearCounts> {
  const one = async (sql: string) =>
    Number((await db.query<{ n: string }>(sql, [tenantId])).rows[0]?.n ?? 0);
  const count = (table: string) =>
    one(`SELECT count(*) AS n FROM ${q(table)} WHERE "tenantId" = $1`);
  return {
    salesOrders: await count("SalesOrder"),
    bills: await count("Bill"),
    customerPayments: await one(`SELECT count(*) AS n FROM (${CLEARED_PAYMENTS}) x`),
    goodsReceipts: await count("GoodsReceipt"),
    companyBills: await count("CompanyBill"),
    companyPayments: await count("CompanyPayment"),
    stockMovements: await count("StockMovement"),
  };
}

/** What a clear would remove now (for the confirmation page). */
export async function previewClearEntries(ctx: ServiceCtx): Promise<ClearCounts> {
  assertCan(ctx.user.role, "settings.manage");
  return withDb((db) => countAll(db, ctx.user.tenantId));
}

/**
 * Deletes rows of a table that refers to itself (`reversalOfId`): the reversals first, so the
 * foreign key never blocks, until none of the chosen rows is left.
 */
async function deleteChain(db: pg.Client, table: string, where: string, params: unknown[]) {
  for (let round = 0; round < 50; round++) {
    const { rowCount } = await db.query(
      `DELETE FROM ${q(table)} t WHERE ${where}
         AND NOT EXISTS (SELECT 1 FROM ${q(table)} r
                         WHERE r."tenantId" = t."tenantId" AND r."reversalOfId" = t.id)`,
      params,
    );
    if (!rowCount) return;
  }
  throw new Error(`Could not clear ${table}: a reversal chain is too long.`);
}

export async function clearEntries(ctx: ServiceCtx, input: unknown): Promise<ClearCounts> {
  assertCan(ctx.user.role, "settings.manage");
  const confirm =
    input && typeof input === "object" && "confirm" in input
      ? String((input as { confirm: unknown }).confirm ?? "").trim()
      : "";
  if (confirm !== CLEAR_CONFIRM_WORD)
    throw new ServiceError(`Type ${CLEAR_CONFIRM_WORD} in capital letters to confirm.`);
  const tenantId = ctx.user.tenantId;

  const cleared = await withDb(async (db) => {
    await db.query("BEGIN");
    try {
      // Wait for a backup that is running, and fail fast instead of hanging if a screen is busy.
      await db.query(`SET LOCAL lock_timeout = '15s'`);
      await db.query(`SELECT pg_advisory_xact_lock(hashtext('taqseem_sync'))`);
      const counts = await countAll(db, tenantId);

      const payments = (await db.query<{ id: string }>(CLEARED_PAYMENTS, [tenantId])).rows.map(
        (r) => r.id,
      );
      const cheques = (
        await db.query<{ id: string }>(
          `SELECT "chequeId" AS id FROM "CustomerPayment"
             WHERE "tenantId" = $1 AND id = ANY ($2::text[]) AND "chequeId" IS NOT NULL
           UNION
           SELECT "chequeId" FROM "CompanyPayment" WHERE "tenantId" = $1 AND "chequeId" IS NOT NULL`,
          [tenantId, payments],
        )
      ).rows.map((r) => r.id);

      // Off for this transaction only (ALTER TABLE is undone by a rollback, and switched back on
      // below): the append-only guards, and the backup's change capture, since the cloud gets a
      // fresh full copy anyway.
      for (const t of TOUCHED) await db.query(`ALTER TABLE ${q(t)} DISABLE TRIGGER USER`);

      const del = (table: string, extra = "", params: unknown[] = []) =>
        db.query(`DELETE FROM ${q(table)} WHERE "tenantId" = $1 ${extra}`, [tenantId, ...params]);

      // The ledger entries of everything cleared below, and any reversal of them.
      await deleteChain(
        db,
        "LedgerEntry",
        `t."tenantId" = $1 AND t.id IN (
           WITH RECURSIVE s AS (
             SELECT id FROM "LedgerEntry" WHERE "tenantId" = $1
               AND ("referenceType" = ANY ($2::text[])
                 OR ("referenceType" = 'CustomerPayment' AND "referenceId" = ANY ($3::text[])))
             UNION
             SELECT l.id FROM "LedgerEntry" l JOIN s ON l."reversalOfId" = s.id
              WHERE l."tenantId" = $1)
           SELECT id FROM s)`,
        [tenantId, CLEARED_LEDGER_REFERENCES, payments],
      );

      await del("CompanyClaim");
      await del("PaymentAllocation");
      await del("CustomerPayment", `AND id = ANY ($2::text[])`, [payments]);
      await del("CustomerReturn");
      await del("DamageReturnLine");
      await del("DamageReturn");
      await del("BillRevision");
      await del("Bill");
      await del("SalesOrderLine");
      await del("SalesOrder");
      await del("CompanyPaymentAllocation");
      await del("CompanyPayment");
      await del("CompanyBill");
      await deleteChain(db, "StockMovement", `t."tenantId" = $1`, [tenantId]);
      await del("Batch");
      await del("StockAdjustment");
      await del("GoodsReceiptLine");
      await del("GoodsReceipt");
      await del("PurchaseOrderLine");
      await del("PurchaseOrder");
      await del("Cheque", `AND id = ANY ($2::text[])`, [cheques]);

      for (const [key, table] of Object.entries(SEQUENCES)) {
        const left = await db.query(`SELECT 1 FROM ${q(table)} WHERE "tenantId" = $1 LIMIT 1`, [
          tenantId,
        ]);
        if (left.rowCount === 0) await del("DocumentSequence", `AND key = $2`, [key]);
      }

      for (const t of TOUCHED) await db.query(`ALTER TABLE ${q(t)} ENABLE TRIGGER USER`);

      // The cloud backup: drop the waiting changes and make the next backup a fresh full copy.
      const sync = await db.query<{ ok: boolean }>(
        `SELECT to_regclass('${SYNC_SCHEMA}.config') IS NOT NULL AS ok`,
      );
      if (sync.rows[0]?.ok) {
        await db.query(`DELETE FROM ${SYNC_SCHEMA}.config WHERE key = 'copied_to'`);
        await db.query(`DELETE FROM ${SYNC_SCHEMA}.outbox`);
      }

      await db.query("COMMIT");
      return { ...counts, customerPayments: payments.length };
    } catch (error) {
      await db.query("ROLLBACK").catch(() => {});
      if ((error as { code?: string }).code === "55P03")
        throw new ServiceError(
          "The database is busy (a backup or another screen is saving). Wait a minute and try again.",
        );
      throw error;
    }
  });

  await writeAudit(ctx.db, ctx.user, {
    action: "DELETE",
    entityType: "Entries",
    entityId: tenantId,
    oldValue: cleared,
  });
  return cleared;
}
