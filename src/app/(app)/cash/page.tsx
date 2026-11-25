import type { Metadata } from "next";

import { CashForms } from "@/components/cash/cash-forms";
import { ReasonAction } from "@/components/form/reason-action";
import { RequirePermission } from "@/components/layout/no-access";
import { PageHeader } from "@/components/layout/page-header";
import { DataTable, EmptyRow, Td, Th } from "@/components/list/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate, toDateInput } from "@/lib/dates";
import { formatMoney } from "@/lib/format";
import { CASH_KIND_LABEL } from "@/lib/validation/cash";
import { requireTenantContext } from "@/server/auth/session";
import {
  addCashMoveAction,
  reverseCashEntryAction,
  saveCashCountAction,
  setOpeningCashAction,
} from "@/server/cash-actions";
import { type CashDay, cashBook } from "@/server/services/cash-book";
import { parseDateRange } from "@/server/services/purchasing/filters";

export const metadata: Metadata = { title: "Cash book" };

export default function CashBookPage({ searchParams }: PageProps<"/cash">) {
  return (
    <RequirePermission permission="payments.manage">
      <PageHeader
        title="Cash book"
        description="The cash in the drawer, day by day: opening cash, cash collected, cash expenses and company payments, cash put in or taken out, and the night's count."
      />
      <Book searchParams={searchParams} />
    </RequirePermission>
  );
}

const num = "text-right tabular-nums";

function Difference({ value }: { value: CashDay["closing"] }) {
  if (value.isZero()) return <span className="text-muted-foreground">Matches</span>;
  return value.lt(0) ? (
    <span className="text-destructive font-medium">{formatMoney(value.abs())} short</span>
  ) : (
    <span className="font-medium text-emerald-700 dark:text-emerald-400">
      {formatMoney(value)} extra
    </span>
  );
}

async function Book({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const ctx = await requireTenantContext("payments.manage");
  const book = await cashBook(ctx, parseDateRange(sp));
  const t = book.today;
  const todayText = toDateInput(t?.date ?? book.to);
  const out = (d: CashDay) => d.expenses.add(d.toCompanies).add(d.taken);
  const into = (d: CashDay) => d.collected.add(d.added);

  return (
    <div className="space-y-6">
      {!book.opening ? (
        <p className="max-w-4xl rounded-lg border border-amber-400 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          No opening cash yet: the book adds up from zero. Count the cash you have now and enter it
          under <strong>Opening cash</strong>.
        </p>
      ) : null}

      {t ? (
        <dl className="grid max-w-4xl gap-3 sm:grid-cols-5">
          {(
            [
              ["Opening today", formatMoney(t.opening)],
              ["+ Cash in", formatMoney(into(t))],
              ["− Cash out", formatMoney(out(t))],
              ["Cash in hand now", formatMoney(t.closing)],
            ] as const
          ).map(([label, value], i) => (
            <div
              key={label}
              className={`bg-card rounded-xl border p-3 ${i === 3 ? "border-primary" : ""}`}
            >
              <dt className="text-muted-foreground text-xs">{label}</dt>
              <dd className={`text-lg tabular-nums ${i === 3 ? "font-bold" : "font-medium"}`}>
                {value}
              </dd>
            </div>
          ))}
          <div className="bg-card rounded-xl border p-3">
            <dt className="text-muted-foreground text-xs">Counted tonight</dt>
            <dd className="text-sm">
              {t.count ? (
                <>
                  <span className="text-lg font-medium tabular-nums">
                    {formatMoney(t.count.counted)}
                  </span>
                  <br />
                  <Difference value={t.count.difference} />
                </>
              ) : (
                <span className="text-muted-foreground">Not counted yet</span>
              )}
            </dd>
          </div>
        </dl>
      ) : null}

      <CashForms
        today={todayText}
        hasOpening={book.opening !== null}
        expected={formatMoney(t?.closing ?? 0)}
        actions={{
          opening: setOpeningCashAction,
          move: addCashMoveAction,
          count: saveCashCountAction,
        }}
      />

      <section className="space-y-2">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="font-medium">
            Day by day{" "}
            <span className="text-muted-foreground font-normal">
              · {formatDate(book.from)} to {formatDate(book.to)}
              {book.opening
                ? ` · opening cash ${formatMoney(book.opening.amount)} on ${formatDate(book.opening.entryDate)}`
                : ""}
            </span>
          </h2>
          <form className="flex flex-wrap items-end gap-2" method="get">
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground block">From</span>
              <Input type="date" name="from" defaultValue={toDateInput(book.from)} />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground block">To</span>
              <Input type="date" name="to" defaultValue={toDateInput(book.to)} />
            </label>
            <Button type="submit" variant="outline">
              Show
            </Button>
          </form>
        </div>
        <DataTable>
          <thead>
            <tr>
              <Th>Day</Th>
              <Th className="text-right">Opening</Th>
              <Th className="text-right">Collected</Th>
              <Th className="text-right">Expenses</Th>
              <Th className="text-right">To companies</Th>
              <Th className="text-right">Put in</Th>
              <Th className="text-right">Taken out</Th>
              <Th className="text-right">Closing</Th>
              <Th className="text-right">Counted</Th>
            </tr>
          </thead>
          <tbody>
            {book.days.length === 0 ? (
              <EmptyRow colSpan={9}>Nothing in this range.</EmptyRow>
            ) : null}
            {book.days.map((d) => (
              <tr key={d.date.toISOString()}>
                <Td>{formatDate(d.date)}</Td>
                <Td className={num}>{formatMoney(d.opening)}</Td>
                <Td className={num}>{formatMoney(d.collected)}</Td>
                <Td className={num}>{formatMoney(d.expenses)}</Td>
                <Td className={num}>{formatMoney(d.toCompanies)}</Td>
                <Td className={num}>{formatMoney(d.added)}</Td>
                <Td className={num}>{formatMoney(d.taken)}</Td>
                <Td className={`${num} font-semibold ${d.closing.lt(0) ? "text-destructive" : ""}`}>
                  {formatMoney(d.closing)}
                </Td>
                <Td className={num}>
                  {d.count ? (
                    <>
                      {formatMoney(d.count.counted)}
                      <br />
                      <span className="text-xs">
                        <Difference value={d.count.difference} />
                      </span>
                    </>
                  ) : (
                    "—"
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </DataTable>
        <p className="text-muted-foreground text-xs">
          Collected = customer payments in cash (counter sales, day-end, office). Put in / taken out
          include the bank and count differences. Days with no cash in or out are not listed.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">Cash entries</h2>
        <DataTable>
          <thead>
            <tr>
              <Th>No.</Th>
              <Th>Date</Th>
              <Th>What</Th>
              <Th>Note</Th>
              <Th className="text-right">In</Th>
              <Th className="text-right">Out</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {book.entries.length === 0 ? (
              <EmptyRow colSpan={7}>No cash entries in this range.</EmptyRow>
            ) : null}
            {book.entries.map((e) => {
              const cancelled = e.status === "REVERSED";
              return (
                <tr key={e.id} className={cancelled ? "text-muted-foreground" : undefined}>
                  <Td>#{e.number}</Td>
                  <Td>{formatDate(e.entryDate)}</Td>
                  <Td>
                    <span className={cancelled ? "line-through" : undefined}>
                      {CASH_KIND_LABEL[e.kind] ?? e.kind}
                    </span>
                    {cancelled ? (
                      <Badge variant="outline" className="ml-2">
                        Cancelled
                      </Badge>
                    ) : null}
                  </Td>
                  <Td>
                    {e.note ?? "—"}
                    {cancelled && e.reversalReason ? (
                      <span className="block text-xs">Cancelled: {e.reversalReason}</span>
                    ) : null}
                  </Td>
                  <Td className={num}>{e.direction === "IN" ? formatMoney(e.amount) : ""}</Td>
                  <Td className={num}>{e.direction === "OUT" ? formatMoney(e.amount) : ""}</Td>
                  <Td className="text-right">
                    {cancelled ? null : (
                      <ReasonAction
                        action={reverseCashEntryAction.bind(null, e.id)}
                        label="Cancel"
                        description={`Cancel cash entry #${e.number} (${CASH_KIND_LABEL[e.kind]}, ${formatMoney(e.amount)})? It stays in the list, crossed out.`}
                      />
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      </section>
    </div>
  );
}
