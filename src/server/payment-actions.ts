"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import type { ActionState } from "@/lib/action-state";
import { businessToday, toDateInput } from "@/lib/dates";
import { formatMoney } from "@/lib/format";

import { runAction } from "./actions";
import { requireTenantContext } from "./auth/session";
import { ServiceError } from "./services/errors";
import {
  bounceCheque,
  clearCheque,
  clearCustomerFlag,
  createCustomerPayment,
  paymentContext,
  type PaymentContext,
  reverseCustomerPayment,
} from "./services/payments/customer-payments";
import { createOldBill, removeOldBill } from "./services/payments/old-bills";
import { customerPending } from "./services/sales/positions";

// Server actions for customer payments at the office. The services check permissions, allocate,
// post to the ledger and audit.

/** What the customer owes (per company, per bill) once they are picked on the payment screen. */
export async function paymentContextAction(
  customerId: string,
): Promise<PaymentContext | { error: string }> {
  try {
    const ctx = await requireTenantContext("payments.manage");
    return await paymentContext(ctx, customerId);
  } catch (error) {
    if (error instanceof ServiceError) return { error: error.message };
    throw error;
  }
}

export async function saveCustomerPaymentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let savedId = "";
  const result = await runAction<undefined>(async () => {
    const ctx = await requireTenantContext("payments.manage");
    const fields: Record<string, string> = {};
    for (const [key, value] of formData)
      if (typeof value === "string" && !key.startsWith("$ACTION")) fields[key] = value;
    savedId = (await createCustomerPayment(ctx, fields)).id;
  }, formData);
  if (result.status !== "success") return result;
  revalidatePath("/payments");
  revalidatePath("/customers");
  redirect(
    formData.get("intent") === "next"
      ? `/payments/new?notice=payment-posted`
      : `/payments/${savedId}?notice=payment-posted`,
  );
}

export async function clearChequeAction(id: string): Promise<ActionState> {
  const result = await runAction<undefined>(async () => {
    const ctx = await requireTenantContext("payments.manage");
    await clearCheque(ctx, { id });
  });
  if (result.status !== "success") return result;
  revalidatePath("/payments");
  redirect(`/payments/${id}?notice=cheque-cleared`);
}

export async function bounceChequeAction(
  id: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const result = await runAction<undefined>(async () => {
    const ctx = await requireTenantContext("payments.manage");
    await bounceCheque(ctx, { id, reason: formData.get("reason") });
  }, formData);
  if (result.status !== "success") return result;
  revalidatePath("/payments");
  revalidatePath("/customers");
  redirect(`/payments/${id}?notice=cheque-bounced`);
}

export async function reverseCustomerPaymentAction(
  id: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const result = await runAction<undefined>(async () => {
    const ctx = await requireTenantContext("payments.manage");
    await reverseCustomerPayment(ctx, { id, reason: formData.get("reason") });
  }, formData);
  if (result.status !== "success") return result;
  revalidatePath("/payments");
  revalidatePath("/customers");
  redirect(`/payments/${id}?notice=payment-reversed`);
}

export async function clearCustomerFlagAction(customerId: string): Promise<ActionState> {
  const result = await runAction<undefined>(async () => {
    const ctx = await requireTenantContext("payments.manage");
    await clearCustomerFlag(ctx, { id: customerId });
  });
  if (result.status !== "success") return result;
  revalidatePath("/customers");
  redirect(`/customers/${customerId}?notice=unflagged`);
}

export async function saveOldBillAction(
  customerId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const result = await runAction<undefined>(async () => {
    const ctx = await requireTenantContext("payments.manage");
    await createOldBill(ctx, {
      requestId: formData.get("requestId"),
      customerId,
      billDate: formData.get("billDate"),
      billNo: formData.get("billNo"),
      amount: formData.get("amount"),
      note: formData.get("note"),
    });
  }, formData);
  if (result.status !== "success") return result;
  revalidatePath("/customers");
  redirect(`/customers/${customerId}/old-bills?notice=old-bill-added`);
}

/**
 * Adds an amount to a customer's balance (what they owe), from the Ledgers page or the order /
 * counter-sale screen: an old-balance entry dated today with the note, shown on the statement as
 * "Added to balance". Stays on the page; the message says what they owe now.
 */
export async function addToBalanceAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const result = await runAction<undefined>(async () => {
    const ctx = await requireTenantContext("payments.manage");
    const customerId = String(formData.get("customerId") ?? "");
    if (!customerId) throw new ServiceError("Choose the customer.");
    const bill = await createOldBill(ctx, {
      requestId: formData.get("requestId"),
      customerId,
      billDate: toDateInput(businessToday()),
      amount: formData.get("amount"),
      note: formData.get("note"),
    });
    const [customer, pending] = await Promise.all([
      ctx.db.customer.findUniqueOrThrow({ where: { id: customerId }, select: { name: true } }),
      customerPending(ctx.db, customerId),
    ]);
    return {
      message: `Rs ${formatMoney(bill.amount)} added to ${customer.name}'s balance. Now owes Rs ${formatMoney(pending.total)}.`,
    };
  }, formData);
  if (result.status === "success") {
    revalidatePath("/ledgers");
    revalidatePath("/customers");
  }
  return result;
}

export async function removeOldBillAction(
  id: string,
  customerId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const result = await runAction<undefined>(async () => {
    const ctx = await requireTenantContext("payments.manage");
    await removeOldBill(ctx, { id, reason: formData.get("reason") });
  }, formData);
  if (result.status !== "success") return result;
  revalidatePath("/customers");
  redirect(`/customers/${customerId}/old-bills?notice=old-bill-removed`);
}
