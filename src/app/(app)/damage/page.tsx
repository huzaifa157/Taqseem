import type { Metadata } from "next";
import Link from "next/link";

import { DataTable, EmptyRow, Td, Th } from "@/components/list/data-table";
import { ListToolbar } from "@/components/list/list-toolbar";
import { Pagination } from "@/components/list/pagination";
import { PageHeader } from "@/components/layout/page-header";
import { LinkButton } from "@/components/master/page-helpers";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/dates";
import { formatMoney } from "@/lib/format";
import { filterParam, listParamsSchema } from "@/lib/list-params";
import { formatDozens } from "@/lib/units";
import { requireTenantContext } from "@/server/auth/session";
import { listDamageReturns } from "@/server/services/damage";
import { parseDateRange } from "@/server/services/purchasing/filters";

export const metadata: Metadata = { title: "Damage" };

export default async function DamagePage({ searchParams }: PageProps<"/damage">) {
  const sp = await searchParams;
  const { q, page } = listParamsSchema.parse(sp);
  const ctx = await requireTenantContext("operations.manage");
  const list = await listDamageReturns(ctx, {
    q,
    page,
    ...parseDateRange(sp),
    status: filterParam(sp, "status"),
  });
  return (
    <>
      <PageHeader
        title="Damage"
        description="Damaged goods customers brought back: what they got in exchange and what was credited or charged to their account. Each company is claimed; settle it under Purchases, Claims."
        actions={<LinkButton href="/damage/new">New damage</LinkButton>}
      />
      <ListToolbar
        basePath="/damage"
        params={{ q, status: "all" }}
        showStatus={false}
        searchPlaceholder="Damage no. or customer"
        dateRange={{ from: filterParam(sp, "from"), to: filterParam(sp, "to"), label: "Date" }}
        filters={[
          {
            name: "status",
            label: "Status",
            value: filterParam(sp, "status"),
            options: [
              { value: "all", label: "All" },
              { value: "REVERSED", label: "Cancelled" },
            ],
          },
        ]}
      />
      <DataTable>
        <thead>
          <tr>
            <Th>No.</Th>
            <Th>Date</Th>
            <Th>Customer</Th>
            <Th className="text-right">Damaged</Th>
            <Th className="text-right">Given in exchange</Th>
            <Th className="text-right">Account</Th>
          </tr>
        </thead>
        <tbody>
          {list.rows.length === 0 ? (
            <EmptyRow colSpan={6}>No damage entries match these filters.</EmptyRow>
          ) : null}
          {list.rows.map((r) => (
            <tr key={r.id}>
              <Td>
                <Link href={`/damage/${r.id}`} className="underline-offset-4 hover:underline">
                  #{r.number}
                </Link>
                {r.status === "REVERSED" ? (
                  <Badge variant="outline" className="ml-2">
                    Cancelled
                  </Badge>
                ) : null}
              </Td>
              <Td>{formatDate(r.returnDate)}</Td>
              <Td>
                {r.customer.name}
                {r.customer.shopName ? (
                  <span className="text-muted-foreground"> · {r.customer.shopName}</span>
                ) : null}
              </Td>
              <Td className="text-right tabular-nums">
                {formatDozens(r.damagedQty)} · {formatMoney(r.damagedAmount)}
              </Td>
              <Td className="text-right tabular-nums">
                {r.replacementQty
                  ? `${formatDozens(r.replacementQty)} · ${formatMoney(r.replacementAmount)}`
                  : "—"}
              </Td>
              <Td className="text-right tabular-nums">
                {r.account.isZero()
                  ? "No change"
                  : r.account.gt(0)
                    ? `Credit ${formatMoney(r.account)}`
                    : `Charge ${formatMoney(r.account.neg())}`}
              </Td>
            </tr>
          ))}
        </tbody>
      </DataTable>
      <Pagination
        basePath="/damage"
        searchParams={sp}
        page={list.page}
        pageCount={list.pageCount}
        total={list.total}
      />
    </>
  );
}
