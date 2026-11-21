import type { Metadata } from "next";

import { RequirePermission } from "@/components/layout/no-access";
import { BackLink, PageHeader } from "@/components/layout/page-header";
import { ClearEntriesForm } from "@/components/settings/clear-entries-form";
import { requireTenantContext } from "@/server/auth/session";
import { CLEAR_CONFIRM_WORD, previewClearEntries } from "@/server/services/clear-entries";
import { clearEntriesAction } from "@/server/settings-actions";

export const metadata: Metadata = { title: "Clear entries" };

export default function ClearEntriesPage() {
  return (
    <RequirePermission permission="settings.manage">
      <BackLink href="/settings">Settings</BackLink>
      <PageHeader
        title="Clear entries"
        description="A clean start before going live: removes trial orders, bills, purchases and stock, and keeps your products, customers and companies."
      />
      <Preview />
    </RequirePermission>
  );
}

async function Preview() {
  const ctx = await requireTenantContext("settings.manage");
  const c = await previewClearEntries(ctx);
  const rows: [string, number][] = [
    ["Sales orders and counter sales", c.salesOrders],
    ["Bills", c.bills],
    ["Customer payments taken with those sales", c.customerPayments],
    ["Goods receipts (purchases)", c.goodsReceipts],
    ["Company bills", c.companyBills],
    ["Company payments", c.companyPayments],
    ["Stock entries (opening stock too)", c.stockMovements],
  ];
  return (
    <div className="max-w-3xl space-y-6">
      <section aria-labelledby="clear-what" className="space-y-3 rounded-lg border p-4">
        <h2 id="clear-what" className="font-medium">
          What will be removed
        </h2>
        <table className="w-full text-sm">
          <tbody>
            {rows.map(([label, n]) => (
              <tr key={label} className="border-b last:border-0">
                <td className="py-1.5">{label}</td>
                <td className="py-1.5 text-right tabular-nums">{n}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-muted-foreground text-sm">
          Also removed: purchase orders, customer returns, damage claims and stock adjustments.
          Order, bill and purchase numbers start again at 1, every stock figure goes to 0 and
          customer and company balances go back to what they were before these entries.
        </p>
        <p className="text-muted-foreground text-sm">
          <strong className="text-foreground">Kept:</strong> companies, products, rates, customers,
          areas, warehouses, bikes, staff, users, customer old balances, delivery trips, expenses
          and the audit log.
        </p>
        <p className="text-muted-foreground text-sm">
          If cloud sync is on, the cloud backup is replaced with a fresh copy within a minute or
          two.
        </p>
      </section>
      <section aria-labelledby="clear-confirm" className="space-y-3 rounded-lg border p-4">
        <h2 id="clear-confirm" className="font-medium">
          Clear the entries
        </h2>
        <ClearEntriesForm action={clearEntriesAction} word={CLEAR_CONFIRM_WORD} />
      </section>
    </div>
  );
}
