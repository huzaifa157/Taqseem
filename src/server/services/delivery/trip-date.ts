import "server-only";

import { z } from "zod";

import { Prisma } from "@/generated/prisma/client";
import { formatDate } from "@/lib/dates";
import { dateSchema, idSchema, requiredText } from "@/lib/validation/master";

import { writeAudit } from "../../audit";
import { assertCan } from "../../auth/permissions";
import { ServiceError } from "../errors";
import type { ServiceCtx } from "../master/common";
import { found } from "../posting";

// Correcting a trip's date (it was entered for the wrong day), also after dispatch and day-end.
// Everything the trip recorded on its day moves to the right day: the trip, its orders' delivery
// date, their bills, the payments collected, returns of earlier goods, damage claims and the
// trip's expenses (petrol). Posted entries are never edited (CLAUDE.md rule 2): each ledger entry
// and stock movement dated on the old day gets a mirror entry on the old day and a fresh copy on
// the new day, so both days' reports come out right. Later entries (a payment taken on another
// day, an undone day-end) are left as they are.

const changeTripDateSchema = z.object({
  id: idSchema,
  date: dateSchema("new date"),
  reason: requiredText("reason", 300),
});

export async function changeTripDate(ctx: ServiceCtx, input: unknown) {
  assertCan(ctx.user.role, "documents.reverse");
  const { id, date, reason } = changeTripDateSchema.parse(input);
  return ctx.db.$transaction(
    async (tx) => {
      const trip = found(
        await tx.deliveryTrip.findUnique({
          where: { id },
          include: { orders: { select: { id: true, number: true, orderDate: true } } },
        }),
        "trip",
      );
      const old = trip.tripDate;
      if (old.getTime() === date.getTime())
        throw new ServiceError("The trip is already on that date.");
      if (trip.status === "CANCELLED") throw new ServiceError("This trip was cancelled.");
      const note = `Date corrected from ${formatDate(old)} to ${formatDate(date)}: ${reason}`;
      const orderIds = trip.orders.map((o) => o.id);

      // The documents of the trip dated on its day.
      const [bills, payments, returns, claims, expenses] = await Promise.all([
        tx.bill.findMany({ where: { salesOrderId: { in: orderIds } }, select: { id: true } }),
        tx.customerPayment.findMany({
          where: { salesOrderId: { in: orderIds }, paymentDate: old },
          select: { id: true },
        }),
        tx.customerReturn.findMany({
          where: { salesOrderId: { in: orderIds }, returnDate: old },
          select: { id: true },
        }),
        tx.companyClaim.findMany({
          where: { salesOrderId: { in: orderIds }, claimDate: old },
          select: { id: true },
        }),
        tx.expense.findMany({ where: { tripId: id, expenseDate: old }, select: { id: true } }),
      ]);
      const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
      const refs = [
        { referenceType: "SalesOrder", referenceId: { in: orderIds } },
        { referenceType: "Bill", referenceId: { in: ids(bills) } },
        { referenceType: "CustomerPayment", referenceId: { in: ids(payments) } },
        { referenceType: "CustomerReturn", referenceId: { in: ids(returns) } },
        { referenceType: "CompanyClaim", referenceId: { in: ids(claims) } },
        { referenceType: "Expense", referenceId: { in: ids(expenses) } },
      ];

      // Ledger: standing entries on the old day → mirror on the old day, copy on the new day.
      const entries = await tx.ledgerEntry.findMany({
        where: { OR: refs, entryDate: old, reversalOfId: null, reversedBy: { none: {} } },
      });
      for (const e of entries) {
        const { id: entryId, createdAt: _c, reversalOfId: _r, requestId: _q, ...rest } = e;
        await tx.ledgerEntry.create({
          data: {
            ...rest,
            debit: e.credit,
            credit: e.debit,
            type: "REVERSAL",
            description: `${note} (was: ${e.description ?? ""})`,
            reversalOfId: entryId,
            createdById: ctx.user.id,
          },
        });
        await tx.ledgerEntry.create({
          data: { ...rest, entryDate: date, createdById: ctx.user.id },
        });
      }

      // Stock: the same for movements of the orders and their returns.
      const moves = await tx.stockMovement.findMany({
        where: {
          OR: refs.slice(0, 1).concat(refs.slice(3, 4)),
          occurredAt: old,
          reversalOfId: null,
          reversedBy: { none: {} },
        },
      });
      for (const m of moves) {
        const { id: moveId, createdAt: _c, reversalOfId: _r, requestId: _q, ...rest } = m;
        await tx.stockMovement.create({
          data: {
            ...rest,
            type: "REVERSAL",
            quantity: -m.quantity,
            note,
            reversalOfId: moveId,
            createdById: ctx.user.id,
          },
        });
        await tx.stockMovement.create({
          data: { ...rest, occurredAt: date, createdById: ctx.user.id },
        });
      }

      // The documents themselves.
      await tx.deliveryTrip.update({ where: { id }, data: { tripDate: date } });
      for (const o of trip.orders)
        await tx.salesOrder.update({
          where: { id: o.id },
          data: {
            deliveryDate: date,
            ...(o.orderDate.getTime() > date.getTime() ? { orderDate: date } : {}),
          },
        });
      await tx.bill.updateMany({
        where: { salesOrderId: { in: orderIds }, billDate: old },
        data: { billDate: date },
      });
      await tx.customerPayment.updateMany({
        where: { id: { in: ids(payments) } },
        data: { paymentDate: date },
      });
      await tx.customerReturn.updateMany({
        where: { id: { in: ids(returns) } },
        data: { returnDate: date },
      });
      await tx.companyClaim.updateMany({
        where: { id: { in: ids(claims) } },
        data: { claimDate: date },
      });
      await tx.expense.updateMany({
        where: { id: { in: ids(expenses) } },
        data: { expenseDate: date },
      });

      await writeAudit(tx, ctx.user, {
        action: "UPDATE",
        entityType: "DeliveryTrip",
        entityId: id,
        oldValue: { tripDate: old },
        newValue: {
          tripDate: date,
          reason,
          orders: trip.orders.map((o) => o.number),
          movedEntries: entries.length,
          movedStock: moves.length,
        },
      });
      return { orders: trip.orders.length };
    },
    { timeout: 60_000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
