"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";

import type { ActionState } from "@/lib/action-state";

import { runAction } from "./actions";
import { ForbiddenError } from "./auth/permissions";
import { requireTenantContext } from "./auth/session";
import { ServiceError } from "./services/errors";
import {
  bookBulkOrders,
  type BulkRowResult,
  saveBulkOrderLayout,
} from "./services/sales/bulk-orders";
import { createCounterSale, editCounterSale } from "./services/sales/counter";
import {
  approveCreditOverride,
  cancelSalesOrder,
  createSalesOrder,
  orderEntryContext,
  type OrderEntryContext,
  updateSalesOrder,
} from "./services/sales/orders";

// Server actions for sales orders. The services check permissions, price, validate and audit.

/** Loads the order screen's customer panel and product list when a customer is picked. */
export async function orderEntryContextAction(
  customerId: string,
  opts: { warehouseId?: string; excludeOrderId?: string } = {},
): Promise<OrderEntryContext | { error: string }> {
  try {
    const ctx = await requireTenantContext("operations.manage");
    return await orderEntryContext(ctx, customerId, opts);
  } catch (error) {
    if (error instanceof ServiceError) return { error: error.message };
    throw error;
  }
}

function orderInput(formData: FormData) {
  const fields: Record<string, string> = {};
  for (const [key, value] of formData) {
    if (
      typeof value === "string" &&
      !key.startsWith("$ACTION") &&
      key !== "productId" &&
      key !== "quantity" &&
      key !== "discount" &&
      !key.startsWith("damage")
    )
      fields[key] = value;
  }
  // "− Damage" on a counter sale: damaged goods deducted from the bill.
  const damageIds = formData.getAll("damageProductId").map(String);
  const damageQty = formData.getAll("damageQuantity").map(String);
  const damageRate = formData.getAll("damageRate").map(String);
  const damaged = damageIds
    .map((productId, i) => ({
      productId,
      quantity: (damageQty[i] ?? "").trim(),
      rate: damageRate[i] ?? "",
    }))
    .filter((l) => l.quantity !== "");
  const ids = formData.getAll("productId").map(String);
  const quantities = formData.getAll("quantity").map(String);
  // One discount per line (blank = the product's discount and slabs).
  const discounts = formData.getAll("discount").map(String);
  const lines = ids.map((productId, i) => ({
    productId,
    quantity: quantities[i] ?? "",
    discount: discounts[i] ?? "",
  }));
  return { ...fields, lines, damaged };
}

/** Books (id = null) or edits an order, then opens it (or a blank order for "Save and next"). */
export async function saveSalesOrderAction(
  id: string | null,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let savedId = "";
  let deliveryDate = "";
  const result = await runAction<undefined>(async () => {
    const ctx = await requireTenantContext("operations.manage");
    const saved = id
      ? await updateSalesOrder(ctx, id, orderInput(formData))
      : await createSalesOrder(ctx, orderInput(formData));
    savedId = saved.id;
    // Validated by the save; a YYYY-MM-DD date.
    deliveryDate = String(formData.get("deliveryDate") ?? "");
  }, formData);
  if (result.status !== "success") return result;
  revalidatePath("/orders");
  redirect(
    formData.get("intent") === "next"
      ? // The next order keeps this one's delivery date.
        `/orders/new?notice=booked&last=${savedId}&date=${deliveryDate}`
      : formData.get("intent") === "print"
        ? `/orders/${savedId}/bill?print=1`
        : `/orders/${savedId}?notice=${id ? "saved" : "booked"}`,
  );
}

/** Saves a counter sale, then opens it (or a blank counter sale for "Save and next"). */
export async function saveCounterSaleAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let savedId = "";
  const result = await runAction<undefined>(async () => {
    const ctx = await requireTenantContext("operations.manage");
    savedId = (await createCounterSale(ctx, orderInput(formData))).id;
  }, formData);
  if (result.status !== "success") return result;
  revalidatePath("/orders");
  revalidatePath("/inventory");
  redirect(
    formData.get("intent") === "next"
      ? `/orders/counter?notice=sold&last=${savedId}`
      : formData.get("intent") === "print"
        ? `/orders/${savedId}/bill?print=1`
        : `/orders/${savedId}?notice=sold`,
  );
}

/** Corrects a saved counter sale, then opens it (or its bill, ready to print again). */
export async function correctCounterSaleAction(
  id: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const result = await runAction<undefined>(async () => {
    const ctx = await requireTenantContext("operations.manage");
    await editCounterSale(ctx, id, orderInput(formData));
  }, formData);
  if (result.status !== "success") return result;
  revalidatePath("/orders");
  revalidatePath("/inventory");
  redirect(
    formData.get("intent") === "print"
      ? `/orders/${id}/bill?print=1`
      : `/orders/${id}?notice=corrected`,
  );
}

/** Expected failures (validation, permission, business rules) as a message; anything else throws. */
function failure(error: unknown): { error: string } {
  if (error instanceof ServiceError) return { error: error.message };
  if (error instanceof ZodError) return { error: error.issues[0]?.message ?? "Check the sheet." };
  if (error instanceof ForbiddenError) return { error: "You do not have permission to do this." };
  throw error;
}

/** Saves the bulk sheet's columns (which products, in which order) for a warehouse. */
export async function saveBulkOrderLayoutAction(
  warehouseId: string,
  productIds: string[],
): Promise<{ columns: string[] } | { error: string }> {
  try {
    const ctx = await requireTenantContext("operations.manage");
    return { columns: await saveBulkOrderLayout(ctx, { warehouseId, productIds }) };
  } catch (error) {
    return failure(error);
  }
}

/** Books every row of the bulk sheet as its own order; each row gets its own result. */
export async function bookBulkOrdersAction(
  input: unknown,
): Promise<{ results: BulkRowResult[] } | { error: string }> {
  try {
    const ctx = await requireTenantContext("operations.manage");
    const results = await bookBulkOrders(ctx, input);
    if (results.some((r) => r.ok)) revalidatePath("/orders");
    return { results };
  } catch (error) {
    return failure(error);
  }
}

export async function cancelSalesOrderAction(id: string): Promise<ActionState> {
  const result = await runAction<undefined>(async () => {
    const ctx = await requireTenantContext("operations.manage");
    await cancelSalesOrder(ctx, { id });
  });
  if (result.status !== "success") return result;
  revalidatePath("/orders");
  redirect(`/orders/${id}?notice=cancelled`);
}

export async function approveCreditAction(id: string): Promise<ActionState> {
  const result = await runAction<undefined>(async () => {
    const ctx = await requireTenantContext("orders.overrideCreditLimit");
    await approveCreditOverride(ctx, { id });
  });
  if (result.status !== "success") return result;
  revalidatePath("/orders");
  redirect(`/orders/${id}?notice=approved`);
}
