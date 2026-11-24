import type { Metadata } from "next";

import { ConfirmAction } from "@/components/form/confirm-action";
import { RequirePermission } from "@/components/layout/no-access";
import { BackLink, PageHeader } from "@/components/layout/page-header";
import { Notice } from "@/components/master/notice";
import { DataTable, Td, Th } from "@/components/list/data-table";
import { LinkButton, orNotFound } from "@/components/master/page-helpers";
import { RecordForm } from "@/components/master/record-form";
import { RecordStatusActions } from "@/components/master/record-status-actions";
import { can } from "@/server/auth/permissions";
import { requireTenantContext } from "@/server/auth/session";
import { formatDate } from "@/lib/dates";
import { formatMoney } from "@/lib/format";
import { saveRecordAction } from "@/server/master-actions";
import { clearCustomerFlagAction } from "@/server/payment-actions";
import { areaOptions } from "@/server/services/master/areas";
import { getCustomer } from "@/server/services/master/customers";
import { listCustomerDiscounts } from "@/server/services/sales/customer-discounts";

import { customerFields } from "../customer-fields";

export const metadata: Metadata = { title: "Edit customer" };

export default function EditCustomerPage({ params, searchParams }: PageProps<"/customers/[id]">) {
  return (
    <RequirePermission permission="masterData.manage">
      <BackLink href="/customers">Customers</BackLink>
      <Notices searchParams={searchParams} />
      <Editor params={params} />
    </RequirePermission>
  );
}

async function Notices({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { notice } = await searchParams;
  return <Notice notice={notice} />;
}

async function Editor({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireTenantContext("masterData.manage");
  const [customer, areas, discounts] = await Promise.all([
    orNotFound(getCustomer(ctx, id)),
    areaOptions(ctx),
    listCustomerDiscounts(ctx, id),
  ]);
  // Keep the current area selectable even if it was deactivated.
  const areaList =
    customer.areaId && customer.area && !areas.some((a) => a.id === customer.areaId)
      ? [
          ...areas,
          {
            id: customer.areaId,
            name: `${customer.area.name} (deactivated)`,
            warehouse: customer.area.warehouse,
          },
        ]
      : areas;
  return (
    <div className="space-y-8">
      <PageHeader
        title={customer.name}
        description={customer.shopName ?? undefined}
        actions={
          <>
            <LinkButton href={`/orders/new?customerId=${id}`}>New order</LinkButton>
            {can(ctx.user.role, "ledgers.view") ? (
              <LinkButton href={`/customers/${id}/statement`} variant="outline">
                Statement (ledger)
              </LinkButton>
            ) : null}
            <LinkButton href={`/customers/${id}/old-bills`} variant="outline">
              Old balance (paper bills)
            </LinkButton>
          </>
        }
      />
      {customer.isFlagged ? (
        <div role="alert" className="border-destructive space-y-2 rounded-md border p-3 text-sm">
          <p className="text-destructive font-medium">
            Flagged: {customer.flagReason ?? "no reason given"}
          </p>
          {can(ctx.user.role, "payments.manage") ? (
            <ConfirmAction
              action={clearCustomerFlagAction.bind(null, id)}
              label="Remove flag"
              confirm={`Remove the flag from ${customer.name}?`}
            />
          ) : null}
        </div>
      ) : null}
      <RecordForm
        action={saveRecordAction.bind(null, "Customer", id)}
        fields={customerFields(
          { ...customer, creditLimit: customer.creditLimit?.toFixed(2) ?? null },
          areaList,
        )}
        isNew={false}
        cancelHref="/customers"
      />
      <section aria-labelledby="discounts-heading" className="max-w-4xl space-y-2">
        <h2 id="discounts-heading" className="font-medium">
          Discounts for this customer
        </h2>
        <p className="text-muted-foreground text-sm">
          Rates are the same for everyone. A discount typed on this customer&apos;s order or counter
          sale is saved here and used on their next ones; clear it on an order to remove it.
        </p>
        {discounts.length === 0 ? (
          <p className="text-sm">None yet: the products&apos; own discounts and slabs apply.</p>
        ) : (
          <DataTable>
            <thead>
              <tr>
                <Th>Product</Th>
                <Th>Company</Th>
                <Th className="text-right">Rate / dz</Th>
                <Th className="text-right">Normal discount</Th>
                <Th className="text-right">Their discount</Th>
                <Th className="text-right">They pay / dz</Th>
                <Th>Changed</Th>
              </tr>
            </thead>
            <tbody>
              {discounts.map((d) => (
                <tr key={d.productId}>
                  <Td>
                    <span className="font-mono">{d.code}</span> {d.name}
                  </Td>
                  <Td className="text-muted-foreground">{d.companyName}</Td>
                  <Td className="text-right tabular-nums">{formatMoney(d.saleRate)}</Td>
                  <Td className="text-right tabular-nums">{d.normalDiscount ?? "—"}</Td>
                  <Td className="text-right font-medium tabular-nums">{formatMoney(d.discount)}</Td>
                  <Td className="text-right tabular-nums">{formatMoney(d.net)}</Td>
                  <Td className="text-muted-foreground">{formatDate(d.updatedAt)}</Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </section>
      <RecordStatusActions
        entity="Customer"
        id={id}
        label="this customer"
        isActive={customer.isActive}
      />
    </div>
  );
}
