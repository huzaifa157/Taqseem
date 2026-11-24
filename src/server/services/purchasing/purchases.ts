import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { purchaseSchema } from "@/lib/validation/purchasing";

import { assertCan } from "../../auth/permissions";
import { ServiceError } from "../errors";
import type { ServiceCtx } from "../master/common";
import { allocateOldestFirst } from "./calc";
import { existingReceipt, postGoodsReceipt } from "./goods-receipts";
import { postCompanyPayment } from "./payments";

// A purchase, in one step and one transaction: the goods that came in (stock as a new batch and
// the company bill, i.e. a goods receipt with no purchase order) and what was paid for them now.
// The payment pays this bill first; anything over it pays the company's older bills, then stays
// as an advance. Blank or 0 paid: the whole bill stays on the company's account.

const D = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v);

export async function createPurchase(ctx: ServiceCtx, input: unknown) {
  assertCan(ctx.user.role, "operations.manage");
  const data = purchaseSchema.parse(input);
  const paid = data.paidAmount ? D(data.paidAmount) : D(0);
  // Paying needs the payment permission; staff can still enter what came in.
  if (paid.gt(0)) assertCan(ctx.user.role, "payments.manage");

  return ctx.db
    .$transaction(
      async (tx) => {
        const existing = await existingReceipt(tx, ctx, data.requestId);
        if (existing) return { receipt: existing, repeated: true };

        const receipt = await postGoodsReceipt(tx, ctx, {
          ...data,
          purchaseOrderId: null,
          dueDate: null,
        });
        if (paid.gt(0)) {
          const billId = receipt.companyBill.id;
          await postCompanyPayment(
            tx,
            ctx,
            {
              requestId: data.requestId,
              companyId: data.companyId,
              paymentDate: data.receivedDate,
              method: data.method,
              amount: paid.toFixed(2),
              reference: data.method === "ONLINE" ? data.reference : null,
              chequeNo: data.chequeNo,
              bankName: data.bankName,
              chequeDate: data.chequeDate,
              note: `Paid with purchase (goods receipt #${receipt.number})`,
              allocationMode: "manual",
              allocations: [],
            },
            // This purchase's bill first, then the company's older bills; the rest is an advance.
            (open) => {
              const first = allocateOldestFirst(
                paid,
                open.filter((b) => b.id === billId),
              );
              const left = first.reduce((s, a) => s.sub(a.amount), paid);
              return [
                ...first,
                ...allocateOldestFirst(
                  left,
                  open.filter((b) => b.id !== billId),
                ),
              ];
            },
          );
        }
        return { receipt, repeated: false };
      },
      // Serializable: like a receipt and a payment, two at once must not use the same claim or bill.
      { timeout: 30_000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    )
    .catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        throw new ServiceError("This purchase was already saved.");
      throw error;
    });
}
