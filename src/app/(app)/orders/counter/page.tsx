import type { Metadata } from "next";

import { Notice } from "@/components/master/notice";
import { OrderEntry } from "@/components/sales/order-entry";
import { businessToday, toDateInput } from "@/lib/dates";
import { filterParam } from "@/lib/list-params";
import { can } from "@/server/auth/permissions";
import { requireTenantContext } from "@/server/auth/session";
import { saveCounterSaleAction } from "@/server/sales-actions";
import { areasForOrders } from "@/server/services/master/areas";
import { warehouseOptions } from "@/server/services/master/warehouses";
import { customersForOrders, getOrderSummary } from "@/server/services/sales/orders";

export const metadata: Metadata = { title: "Counter sale" };

export default async function CounterSalePage({ searchParams }: PageProps<"/orders/counter">) {
  const sp = await searchParams;
  const ctx = await requireTenantContext("operations.manage");
  const lastId = filterParam(sp, "last");
  const customerId = filterParam(sp, "customerId");
  const [customers, warehouses, last, areas] = await Promise.all([
    customersForOrders(ctx),
    warehouseOptions(ctx),
    lastId ? getOrderSummary(ctx, lastId) : null,
    areasForOrders(ctx),
  ]);
  return (
    <>
      <OrderEntry
        header={{
          backHref: "/orders",
          backLabel: "Orders",
          title: "Counter sale",
          description:
            "The customer collects the goods now: stock leaves the warehouse and the bill is posted. Anything unpaid goes on account.",
        }}
        notice={
          <Notice
            notice={sp.notice}
            text={
              last ? `Counter sale #${last.number} for ${last.customer.name} saved.` : undefined
            }
            next={
              last
                ? [
                    { href: `/orders/${last.id}/bill`, label: "Print its bill" },
                    { href: `/orders/${last.id}`, label: "Open it" },
                  ]
                : []
            }
          />
        }
        key={`${lastId ?? ""}:${customerId ?? ""}`}
        mode="counter"
        action={saveCounterSaleAction}
        customers={customers}
        warehouses={warehouses}
        areas={areas}
        canOverrideCredit={can(ctx.user.role, "orders.overrideCreditLimit")}
        initial={{
          orderDate: toDateInput(businessToday()),
          deliveryDate: toDateInput(businessToday()),
          customerId: customers.some((c) => c.id === customerId) ? customerId : undefined,
        }}
      />
    </>
  );
}
