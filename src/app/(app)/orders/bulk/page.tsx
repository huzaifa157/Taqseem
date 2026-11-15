import type { Metadata } from "next";

import { BackLink, PageHeader } from "@/components/layout/page-header";
import { BulkOrderEntry } from "@/components/sales/bulk-order-entry";
import { businessToday, toDateInput } from "@/lib/dates";
import { filterParam } from "@/lib/list-params";
import { can } from "@/server/auth/permissions";
import { requireTenantContext } from "@/server/auth/session";
import { warehouseOptions } from "@/server/services/master/warehouses";
import { addDays } from "@/server/services/purchasing/calc";
import { bulkOrderSheet } from "@/server/services/sales/bulk-orders";

export const metadata: Metadata = { title: "Bulk orders" };

export default async function BulkOrdersPage({ searchParams }: PageProps<"/orders/bulk">) {
  const sp = await searchParams;
  const ctx = await requireTenantContext("operations.manage");
  const warehouses = await warehouseOptions(ctx);
  const chosen = filterParam(sp, "warehouse");
  const warehouseId = warehouses.some((w) => w.id === chosen) ? chosen! : warehouses[0]?.id;
  const sheet = warehouseId ? await bulkOrderSheet(ctx, warehouseId) : null;
  const today = businessToday();
  return (
    <>
      <BackLink href="/orders">Orders</BackLink>
      <PageHeader
        title="Bulk orders"
        description="The order booker's whole list at once: customers down, products across, dozens in the cells. Each row is booked as its own order."
      />
      {sheet ? (
        <BulkOrderEntry
          key={sheet.warehouse.id}
          sheet={sheet}
          warehouses={warehouses}
          canOverrideCredit={can(ctx.user.role, "orders.overrideCreditLimit")}
          initial={{
            orderDate: toDateInput(today),
            deliveryDate: toDateInput(addDays(today, 1)),
          }}
        />
      ) : (
        <p className="text-muted-foreground text-sm">Add a warehouse first (Settings).</p>
      )}
    </>
  );
}
