import type { Metadata } from "next";
import Link from "next/link";

import { AutoPrint } from "@/components/layout/print-button";
import { orNotFound } from "@/components/master/page-helpers";
import { BillSheets } from "@/components/print/bill-sheets";
import { PrintToolbar } from "@/components/print/print-frame";
import { billDocuments } from "@/components/sales/bill-document";
import { Badge } from "@/components/ui/badge";
import { toDateInput } from "@/lib/dates";
import { filterParam } from "@/lib/list-params";
import { paperHint } from "@/lib/print";
import { requireTenantContext } from "@/server/auth/session";
import { getBillView } from "@/server/services/sales/bills";
import { getPrintProfile } from "@/server/services/settings";

export const metadata: Metadata = { title: "Bill" };

export default async function BillPage({ params, searchParams }: PageProps<"/orders/[id]/bill">) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const ctx = await requireTenantContext("operations.manage");
  const [view, profile] = await Promise.all([
    orNotFound(getBillView(ctx, id)),
    getPrintProfile(ctx),
  ]);
  return (
    <div>
      <PrintToolbar
        back={
          filterParam(sp, "print") === "1"
            ? view.order.fulfilment === "COUNTER"
              ? { href: "/orders/counter", label: "Next counter sale" }
              : {
                  href: `/orders/new?date=${toDateInput(view.order.deliveryDate)}`,
                  label: "Next order",
                }
            : { href: `/orders/${id}`, label: `Order #${view.order.number}` }
        }
        hint={paperHint(profile.print)}
      >
        {view.bill.status === "REVERSED" ? <Badge variant="outline">Cancelled</Badge> : null}
        {view.order.fulfilment === "COUNTER" && view.order.status === "DELIVERED" ? (
          <Link
            href={`/orders/${id}/edit`}
            className="hover:bg-accent rounded-md border px-3 py-1.5 text-sm"
            title="A mistake on this sale? Correct it, then print the bill again."
          >
            Correct sale
          </Link>
        ) : null}
        {view.bill.revision > 1 ? (
          <span className="text-muted-foreground text-sm">Revision {view.bill.revision}</span>
        ) : null}
        {!view.bill.posted && view.bill.status !== "REVERSED" ? (
          <span className="text-muted-foreground text-sm">
            Draft until dispatch: amounts can still change.
          </span>
        ) : null}
      </PrintToolbar>
      <BillSheets
        settings={profile.print}
        bills={billDocuments(view, profile.business, profile.print)}
      />
      {filterParam(sp, "print") === "1" ? <AutoPrint /> : null}
    </div>
  );
}
