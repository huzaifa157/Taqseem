import type { Metadata } from "next";
import Link from "next/link";

import { ReasonAction } from "@/components/form/reason-action";
import { DataTable, Td, Th } from "@/components/list/data-table";
import { BackLink, PageHeader } from "@/components/layout/page-header";
import { Notice } from "@/components/master/notice";
import { LinkButton, orNotFound } from "@/components/master/page-helpers";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/dates";
import { formatMoney } from "@/lib/format";
import { formatDozens } from "@/lib/units";
import { can } from "@/server/auth/permissions";
import { requireTenantContext } from "@/server/auth/session";
import { reverseDamageAction } from "@/server/damage-actions";
import { getDamageReturn } from "@/server/services/damage";
import { CLAIM_STATUS_LABEL } from "@/server/services/reports/damage";

export const metadata: Metadata = { title: "Damage" };

type Detail = Awaited<ReturnType<typeof getDamageReturn>>;

function Lines({
  title,
  rows,
  total,
}: {
  title: string;
  rows: Detail["damagedLines"];
  total: Detail["damagedAmount"];
}) {
  return (
    <section className="space-y-2">
      <h2 className="font-medium">{title}</h2>
      <DataTable>
        <thead>
          <tr>
            <Th>Code</Th>
            <Th>Product</Th>
            <Th className="text-right">Quantity</Th>
            <Th className="text-right">Rate / dz</Th>
            <Th className="text-right">Value</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => (
            <tr key={l.id}>
              <Td className="font-mono">{l.product.code}</Td>
              <Td>{l.product.name}</Td>
              <Td className="text-right tabular-nums">{formatDozens(l.quantity)}</Td>
              <Td className="text-right tabular-nums">{formatMoney(l.rate)}</Td>
              <Td className="text-right tabular-nums">{formatMoney(l.amount)}</Td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-medium">
            <Td>Total</Td>
            <Td />
            <Td />
            <Td />
            <Td className="text-right tabular-nums">{formatMoney(total)}</Td>
          </tr>
        </tfoot>
      </DataTable>
    </section>
  );
}

export default async function DamageEntryPage({ params, searchParams }: PageProps<"/damage/[id]">) {
  const [{ id }, { notice }] = await Promise.all([params, searchParams]);
  const ctx = await requireTenantContext("operations.manage");
  const d = await orNotFound(getDamageReturn(ctx, id));
  return (
    <div className="space-y-6">
      <div>
        <BackLink href="/damage">Damage</BackLink>
        <PageHeader
          title={`Damage #${d.number}`}
          description={`${d.customer.name}${d.customer.shopName ? ` · ${d.customer.shopName}` : ""} · ${formatDate(d.returnDate)}`}
          actions={<LinkButton href="/damage/new">New damage</LinkButton>}
        />
        <Notice notice={notice} />
        {d.status === "REVERSED" ? (
          <p className="text-sm">
            <Badge variant="outline">Cancelled</Badge> {d.reversalReason}
          </p>
        ) : null}
        {d.note ? <p className="mt-2 text-sm">{d.note}</p> : null}
      </div>
      <Lines title="Damaged items" rows={d.damagedLines} total={d.damagedAmount} />
      {d.replacementLines.length ? (
        <Lines title="Given in exchange" rows={d.replacementLines} total={d.replacementAmount} />
      ) : null}
      <p className="text-lg">
        {d.account.isZero() ? (
          "Customer's account: no change (an exchange of the same value)."
        ) : d.account.gt(0) ? (
          <>
            Credited to the customer&apos;s account:{" "}
            <strong className="tabular-nums">{formatMoney(d.account)}</strong>
          </>
        ) : (
          <>
            Added to the customer&apos;s account:{" "}
            <strong className="tabular-nums">{formatMoney(d.account.neg())}</strong>
          </>
        )}{" "}
        <Link
          href={`/customers/${d.customer.id}/statement`}
          className="text-sm underline underline-offset-4"
        >
          Statement
        </Link>
      </p>
      {d.claims.length ? (
        <section className="space-y-2">
          <h2 className="font-medium">Company claims</h2>
          <ul className="space-y-1 text-sm">
            {d.claims.map((c) => (
              <li key={c.id}>
                Claim #{c.number} · {c.company.name} · {formatMoney(c.amount)} ·{" "}
                {CLAIM_STATUS_LABEL[c.status as keyof typeof CLAIM_STATUS_LABEL] ?? c.status}
                {c.status === "AWAITING" ? (
                  <>
                    {" · "}
                    <Link href="/purchases/claims" className="underline underline-offset-4">
                      settle with the company
                    </Link>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {d.status === "POSTED" && can(ctx.user.role, "documents.reverse") ? (
        <ReasonAction
          action={reverseDamageAction.bind(null, d.id)}
          label="Cancel damage"
          description="Cancelling reverses the stock, the customer's account entry and the company claims. Not possible once the damaged goods went back to the company or a claim was deducted on a company bill."
        />
      ) : null}
    </div>
  );
}
