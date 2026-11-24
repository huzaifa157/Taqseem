"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import type { ActionState } from "@/lib/action-state";

import { runAction } from "./actions";
import { requireTenantContext } from "./auth/session";
import { createDamageReturn, reverseDamageReturn } from "./services/damage";

// Server actions for customer damage (the Damage screen). The service checks permissions, posts
// the stock, the customer's account and the company claims, and audits.

/** Lines arrive as parallel arrays: `${prefix}ProductId[]`, `${prefix}Quantity[]`, `${prefix}Rate[]`. */
function lines(formData: FormData, prefix: "damaged" | "replacement") {
  const ids = formData.getAll(`${prefix}ProductId`).map(String);
  const quantities = formData.getAll(`${prefix}Quantity`).map(String);
  const rates = formData.getAll(`${prefix}Rate`).map(String);
  return ids
    .map((productId, i) => ({
      productId,
      quantity: (quantities[i] ?? "").trim(),
      rate: rates[i] ?? "",
    }))
    .filter((l) => l.quantity !== "");
}

export async function saveDamageAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let savedId = "";
  const result = await runAction<undefined>(async () => {
    const ctx = await requireTenantContext("operations.manage");
    const entry = await createDamageReturn(ctx, {
      requestId: formData.get("requestId"),
      customerId: formData.get("customerId"),
      returnDate: formData.get("returnDate"),
      note: formData.get("note"),
      damaged: lines(formData, "damaged"),
      replacements: lines(formData, "replacement"),
    });
    savedId = entry.id;
  }, formData);
  if (result.status !== "success") return result;
  revalidatePath("/damage");
  revalidatePath("/inventory");
  redirect(
    formData.get("intent") === "next"
      ? `/damage/new?notice=damage-saved&last=${savedId}`
      : `/damage/${savedId}?notice=damage-saved`,
  );
}

export async function reverseDamageAction(
  id: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const result = await runAction<undefined>(async () => {
    const ctx = await requireTenantContext("documents.reverse");
    await reverseDamageReturn(ctx, { id, reason: formData.get("reason") });
    return { message: "Damage cancelled: stock, account and claims reversed." };
  });
  if (result.status === "success") revalidatePath(`/damage/${id}`);
  return result;
}
