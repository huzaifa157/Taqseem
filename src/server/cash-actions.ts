"use server";

import { revalidatePath } from "next/cache";

import type { ActionState } from "@/lib/action-state";
import { formatMoney } from "@/lib/format";

import { runAction } from "./actions";
import { requireTenantContext } from "./auth/session";
import { addCashMove, reverseCashEntry, saveCashCount, setOpeningCash } from "./services/cash-book";

// Server actions for the cash book. The service checks permissions, validates and audits.

const fields = (formData: FormData) => {
  const out: Record<string, string> = {};
  for (const [key, value] of formData)
    if (typeof value === "string" && !key.startsWith("$ACTION")) out[key] = value;
  return out;
};

const refresh = () => {
  revalidatePath("/cash");
  revalidatePath("/reports/daily");
};

export async function setOpeningCashAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const result = await runAction<undefined>(async () => {
    const ctx = await requireTenantContext("payments.manage");
    const e = await setOpeningCash(ctx, fields(formData));
    return { message: `Opening cash set to ${formatMoney(e.amount)}.` };
  }, formData);
  if (result.status === "success") refresh();
  return result;
}

export async function addCashMoveAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const result = await runAction<undefined>(async () => {
    const ctx = await requireTenantContext("payments.manage");
    const e = await addCashMove(ctx, fields(formData));
    return { message: `Saved (cash entry #${e.number}).` };
  }, formData);
  if (result.status === "success") refresh();
  return result;
}

export async function saveCashCountAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const result = await runAction<undefined>(async () => {
    const ctx = await requireTenantContext("payments.manage");
    const r = await saveCashCount(ctx, fields(formData));
    const diff = r.difference;
    const what = diff.isZero()
      ? "The cash matches the book."
      : diff.lt(0)
        ? `${formatMoney(diff.abs())} short.`
        : `${formatMoney(diff)} extra.`;
    return {
      message: `Count saved. ${what}${r.corrected ? " The book now matches the count." : ""}`,
    };
  }, formData);
  if (result.status === "success") refresh();
  return result;
}

export async function reverseCashEntryAction(
  id: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const result = await runAction<undefined>(async () => {
    const ctx = await requireTenantContext("payments.manage");
    await reverseCashEntry(ctx, { id, reason: formData.get("reason") });
    return { message: "Entry cancelled." };
  }, formData);
  if (result.status === "success") refresh();
  return result;
}
