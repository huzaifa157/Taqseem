"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { signOut } from "@/auth";

import type { ActionState } from "@/lib/action-state";

import { runAction } from "./actions";
import { requireTenantContext } from "./auth/session";
import { clearEntries } from "./services/clear-entries";
import { ServiceError } from "./services/errors";
import {
  disableCloudSync,
  enableCloudSync,
  restoreFromCloud,
  setBackupTime,
} from "./services/cloud-sync";
import { setLogo, updateBusinessSettings } from "./services/settings";
import { syncNow } from "./sync/agent";

// Settings → Business & printing. Each action re-checks the session; the service checks the
// permission again, validates and writes the audit log.

export async function saveBusinessSettingsAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await requireTenantContext("settings.manage");
    const input: Record<string, string> = {};
    for (const [key, value] of formData)
      if (typeof value === "string" && !key.startsWith("$ACTION")) input[key] = value;
    await updateBusinessSettings(ctx, input);
    revalidatePath("/", "layout");
    return { message: "Settings saved." };
  }, formData);
}

export async function uploadLogoAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await requireTenantContext("settings.manage");
    const file = formData.get("logo");
    if (!(file instanceof File) || file.size === 0) throw new ServiceError("Choose an image file.");
    await setLogo(ctx, { bytes: new Uint8Array(await file.arrayBuffer()) });
    revalidatePath("/", "layout");
    return { message: "Logo uploaded." };
  });
}

export async function removeLogoAction(_prev: ActionState): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await requireTenantContext("settings.manage");
    await setLogo(ctx, null);
    revalidatePath("/", "layout");
    return { message: "Logo removed." };
  });
}

// Settings → Cloud sync.

export async function enableCloudSyncAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await requireTenantContext("settings.manage");
    await enableCloudSync(ctx, { url: formData.get("url") });
    // The first run (and the full copy) starts now, in the background.
    void syncNow();
    revalidatePath("/settings/cloud-sync");
    return {
      message:
        "Cloud backup is on. The first full copy is starting now; after that it backs up every day.",
    };
  });
}

export async function clearEntriesAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await requireTenantContext("settings.manage");
    const c = await clearEntries(ctx, { confirm: formData.get("confirm") });
    revalidatePath("/", "layout");
    return {
      message: `Cleared: ${c.salesOrders} orders, ${c.bills} bills, ${c.customerPayments} customer payments, ${c.goodsReceipts} goods receipts, ${c.companyBills} company bills, ${c.companyPayments} company payments and ${c.stockMovements} stock entries. Products, customers and companies are kept.`,
    };
  });
}

export async function syncNowAction(): Promise<ActionState> {
  return runAction(async () => {
    await requireTenantContext("settings.manage");
    const result = await syncNow();
    revalidatePath("/settings/cloud-sync");
    if (result.status === "error") throw new ServiceError(result.message);
    if (result.status === "off") throw new ServiceError("Cloud sync is off.");
    return {
      message:
        result.status === "busy"
          ? "A backup is already running."
          : result.copied
            ? "Backed up: full copy made."
            : `Backed up (${result.sent} ${result.sent === 1 ? "change" : "changes"} sent).`,
    };
  });
}

export async function setBackupTimeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await requireTenantContext("settings.manage");
    await setBackupTime(ctx, { time: formData.get("time") });
    revalidatePath("/settings/cloud-sync");
    return { message: "Saved. The daily backup runs at the new time." };
  });
}

export async function disableCloudSyncAction(): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await requireTenantContext("settings.manage");
    await disableCloudSync(ctx);
    revalidatePath("/settings/cloud-sync");
    return { message: "Cloud sync is off. The cloud copy stays as it is." };
  });
}

/**
 * Replaces this computer's data with the cloud copy. The signed-in user is replaced too, so it
 * ends with the login page: everyone signs in with their login from the restored data.
 */
export async function restoreFromCloudAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const result = await runAction(async () => {
    const ctx = await requireTenantContext("settings.manage");
    await restoreFromCloud(ctx, { url: formData.get("url"), confirm: formData.get("confirm") });
  });
  if (result.status !== "success") return result;
  await signOut({ redirect: false });
  redirect("/login?restored=1");
}
