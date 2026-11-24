import type { Metadata } from "next";

import { RequirePermission } from "@/components/layout/no-access";
import { LinkButton, orNotFound } from "@/components/master/page-helpers";
import { PrintStyles, PrintToolbar } from "@/components/print/print-frame";
import { StatementRangeForm } from "@/components/print/range-form";
import { StatementDocument } from "@/components/print/statement-document";
import { Button } from "@/components/ui/button";
import { businessToday, toDateInput } from "@/lib/dates";
import { statementPageCss } from "@/lib/print";
import { can } from "@/server/auth/permissions";
import { requireTenantContext } from "@/server/auth/session";
import { defaultLedgerRange, parseDateRange } from "@/server/services/purchasing/filters";
import { getPrintProfile } from "@/server/services/settings";
import { getCustomerStatement } from "@/server/services/statements";

export const metadata: Metadata = { title: "Customer statement" };

export default function CustomerStatementPage(props: PageProps<"/customers/[id]/statement">) {
  return (
    <RequirePermission permission="ledgers.view">
      <Statement {...props} />
    </RequirePermission>
  );
}

async function Statement({ params, searchParams }: PageProps<"/customers/[id]/statement">) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const parsed = parseDateRange(sp);
  const range = parsed.from || parsed.to ? parsed : defaultLedgerRange(businessToday());
  const ctx = await requireTenantContext("ledgers.view");
  const [statement, profile] = await Promise.all([
    orNotFound(getCustomerStatement(ctx, id, range)),
    getPrintProfile(ctx),
  ]);
  const { customer } = statement;
  const exportQuery = new URLSearchParams({
    ...(range.from ? { from: toDateInput(range.from) } : {}),
    ...(range.to ? { to: toDateInput(range.to) } : {}),
  }).toString();

  return (
    <div className="print-root">
      <PrintStyles css={statementPageCss(profile.print)} />
      <PrintToolbar back={{ href: "/customers", label: "Customers" }} hint="Prints on A4">
        <Button asChild variant="outline" size="sm">
          <a href={`/customers/${id}/statement/export?${exportQuery}`}>Download Excel</a>
        </Button>
        {can(ctx.user.role, "payments.manage") ? (
          <LinkButton href={`/payments/new?customerId=${id}`} variant="outline">
            Receive payment
          </LinkButton>
        ) : null}
        <LinkButton href={`/orders/new?customerId=${id}`} variant="outline">
          New order
        </LinkButton>
        {can(ctx.user.role, "payments.manage") ? (
          <LinkButton href={`/customers/${id}/old-bills`} variant="outline">
            Old balance
          </LinkButton>
        ) : null}
      </PrintToolbar>
      <StatementRangeForm range={range} />
      <StatementDocument
        business={profile.business}
        title="Customer statement"
        party={
          <>
            <p className="font-semibold">{customer.name}</p>
            {customer.shopName ? <p>{customer.shopName}</p> : null}
            {customer.address ? <p>{customer.address}</p> : null}
            <p>
              {[customer.areaName && `Area: ${customer.areaName}`, customer.phone]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </>
        }
        range={range}
        columns={{ increase: "Bills (+)", decrease: "Received (−)", balance: "Balance due" }}
        opening={statement.opening}
        rows={statement.rows.map((r) => ({ ...r, increase: r.debit, decrease: r.credit }))}
        closing={statement.closing}
        showCompany={false}
      />
    </div>
  );
}
