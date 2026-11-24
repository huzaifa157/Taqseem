import type { Metadata } from "next";

import { BackLink, EmptyState, PageHeader } from "@/components/layout/page-header";
import { Notice } from "@/components/master/notice";
import { PurchaseEntry } from "@/components/purchasing/purchase-entry";
import { businessToday, toDateInput } from "@/lib/dates";
import { filterParam } from "@/lib/list-params";
import { can } from "@/server/auth/permissions";
import { requireTenantContext } from "@/server/auth/session";
import { savePurchaseAction } from "@/server/purchasing-actions";
import { productsForPurchasing } from "@/server/services/purchasing/purchase-orders";

export const metadata: Metadata = { title: "New purchase" };

/** A purchase in one step: what came in from a company, and what was paid for it now. */
export default async function NewPurchasePage({ searchParams }: PageProps<"/purchases/new">) {
  const sp = await searchParams;
  const ctx = await requireTenantContext("operations.manage");
  const [companies, products] = await Promise.all([
    ctx.db.company.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    productsForPurchasing(ctx),
  ]);
  const last = filterParam(sp, "last");
  return (
    <>
      <BackLink href="/purchases/receipts">Purchases</BackLink>
      <PageHeader
        title="New purchase"
        description="What came in from the company and what you paid now. Saving adds the stock and the company bill; anything not paid stays on the company's account."
      />
      {companies.length === 0 ? (
        <EmptyState>Add a company and its products first.</EmptyState>
      ) : (
        <PurchaseEntry
          key={last ?? "new"}
          action={savePurchaseAction}
          companies={companies}
          products={products.map((p) => ({ ...p, purchaseRate: p.purchaseRate }))}
          today={toDateInput(businessToday())}
          showRate={can(ctx.user.role, "financials.view")}
          canPay={can(ctx.user.role, "payments.manage")}
          notice={
            <Notice
              notice={sp.notice}
              next={last ? [{ href: `/purchases/receipts/${last}`, label: "Open it" }] : []}
            />
          }
        />
      )}
    </>
  );
}
