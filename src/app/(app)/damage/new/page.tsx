import type { Metadata } from "next";

import { BackLink, PageHeader } from "@/components/layout/page-header";
import { DamageEntry } from "@/components/damage/damage-entry";
import { Notice } from "@/components/master/notice";
import { businessToday, toDateInput } from "@/lib/dates";
import { filterParam } from "@/lib/list-params";
import { requireTenantContext } from "@/server/auth/session";
import { saveDamageAction } from "@/server/damage-actions";
import { warehouseOptions } from "@/server/services/master/warehouses";
import { customersForOrders } from "@/server/services/sales/orders";

export const metadata: Metadata = { title: "New damage" };

/** A customer brings back damaged goods: credit, goods in exchange, or both. */
export default async function NewDamagePage({ searchParams }: PageProps<"/damage/new">) {
  const sp = await searchParams;
  const ctx = await requireTenantContext("operations.manage");
  const [customers, warehouses] = await Promise.all([
    customersForOrders(ctx),
    warehouseOptions(ctx),
  ]);
  const last = filterParam(sp, "last");
  return (
    <>
      <BackLink href="/damage">Damage</BackLink>
      <PageHeader
        title="New damage"
        description="Damaged goods a customer brought back. Give other goods in exchange, credit their account, or both; the company is claimed for the damage."
      />
      <DamageEntry
        key={last ?? "new"}
        action={saveDamageAction}
        customers={customers}
        defaultWarehouseId={warehouses[0]?.id ?? ""}
        today={toDateInput(businessToday())}
        notice={
          <Notice
            notice={sp.notice}
            next={last ? [{ href: `/damage/${last}`, label: "Open it" }] : []}
          />
        }
      />
    </>
  );
}
