import Decimal from "decimal.js";

import { formatDate } from "@/lib/dates";
import { formatMoney } from "@/lib/format";
import {
  BILL_ROW_EM,
  type BillPagination,
  billPagination,
  paginateBill,
  type PrintSettings,
  usesCompactBill,
} from "@/lib/print";
import { formatDozensCell } from "@/lib/units";
import type { BillView } from "@/server/services/sales/bills";
import type { PrintProfile } from "@/server/services/settings";

type Line = BillView["lines"][number];
type Paid = BillView["paid"];

/** Used by the compact bill: "This bill" stands out; previous, total due and minimum smaller. */
const THIS_BILL = "text-[1.3em] leading-tight font-bold";
const SMALL = "text-[0.85em]";
/** Small grey capitals for labels ("BILL TO", "ACCOUNT"): prints as a light grey. */
const LABEL = "text-[0.72em] font-semibold tracking-[0.1em] uppercase text-black/60";
const MUTED = "text-[0.85em] text-black/70";

const METHOD_NAMES: Record<string, string> = { CASH: "cash", CHEQUE: "cheque", ONLINE: "online" };

/** "Paid now (cash)", "Paid now (cash, cheque)". */
function paidLabel(paid: Paid) {
  const how = paid.methods.map((m) => METHOD_NAMES[m] ?? m.toLowerCase()).join(", ");
  return how ? `Paid now (${how})` : "Paid now";
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type Sums = { dz: number; discount: Decimal; amount: Decimal };
const NO_SUMS: Sums = { dz: 0, discount: new Decimal(0), amount: new Decimal(0) };
/** Each line at its full price (the discount is taken off under the subtotal). */
const gross = (l: Line) => new Decimal(l.netAmount).add(l.discountAmount);
function addLines(start: Sums, lines: Line[]): Sums {
  return lines.reduce(
    (s, l) => ({
      dz: s.dz + l.quantity,
      discount: s.discount.add(l.discountAmount),
      amount: s.amount.add(gross(l)),
    }),
    start,
  );
}

/**
 * One printed bill (full, or one company's slice). Printed one per sheet it is laid out page by
 * page (lib/print.ts billPagination): page 1 has the letterhead and "Bill to", later pages a short
 * header and "brought forward"; every page but the last ends with "carried forward"; the last has
 * the totals, the customer's account and "This bill"; each page's foot has the business's bill
 * note (or "continued on page 2") and "Page 1 of 2". Every line is one row (a long name is cut),
 * so the page sums hold. Two to a sheet it is one block, as before. Black and white only (lines
 * and light greys); sizes in em so the tenant's font size setting scales everything.
 */
export function BillDocument({
  view,
  business,
  title,
  lines,
  thisBill,
  previous,
  oldBalance,
  totalDue,
  minimum,
  paid,
  showCompany,
  pagination = null,
}: {
  view: BillView;
  business: PrintProfile["business"];
  title?: string;
  lines: Line[];
  thisBill: { toString(): string };
  previous: { toString(): string };
  /** Part of `previous` from old paper bills; shown on its own line on the full bill. */
  oldBalance?: { toString(): string };
  totalDue: { toString(): string };
  /** Shown on the full bill only: the credit limit is the customer's, not a company's. */
  minimum?: { toString(): string };
  /** Paid with the order (full bill only): shown with the balance left. */
  paid?: Paid;
  showCompany: boolean;
  /** Page sizes when the bill is printed one per sheet; null: one block. */
  pagination?: BillPagination | null;
}) {
  const pages = pagination ? paginateBill(lines, pagination) : [lines];
  // Running sums at the start of each page (for "brought forward") and after the last.
  const starts: Sums[] = [];
  let running = NO_SUMS;
  for (const page of pages) {
    starts.push(running);
    running = addLines(running, page);
  }
  const totals = running;
  const wide = pagination?.wide ?? false;
  // The company column needs room: A4 (or a half-A4 bill), not a paginated A5 page.
  const withCompany = showCompany && (wide || !pagination);
  const dz = formatDozensCell;
  const counter = view.order.fulfilment === "COUNTER";
  const paidAmount = paid ? new Decimal(paid.amount.toString()) : new Decimal(0);
  const balance = new Decimal(totalDue.toString()).sub(paidAmount);
  const hasOld = oldBalance && !new Decimal(oldBalance.toString()).isZero();
  const sale = counter
    ? [
        "Counter sale",
        ...(paid && !paidAmount.isZero()
          ? [paid.methods.map((m) => capitalise(METHOD_NAMES[m] ?? m)).join(", ")]
          : []),
      ].join(" · ")
    : `Delivery · ${formatDate(view.order.deliveryDate)}`;
  const customerLine = [view.customer.address, view.customer.areaName, view.customer.phone]
    .filter(Boolean)
    .join(" · ");
  const billNo = (
    <>
      <span className="text-[0.75em] font-semibold tracking-[0.25em] text-black/60">BILL </span>
      <span className="text-[1.25em] font-bold">#{view.bill.number}</span>
      {view.bill.revision > 1 ? (
        <span className="text-[0.85em]"> rev. {view.bill.revision}</span>
      ) : null}
    </>
  );

  // Cells: one line per row at a fixed height, so the page sums hold.
  const row = { height: `${BILL_ROW_EM}em` };
  const td = "px-[0.35em] py-0 align-middle whitespace-nowrap";
  const num = `${td} text-right tabular-nums`;
  const th = `${LABEL} px-[0.35em] pb-[0.3em] text-left font-semibold`;
  const tick = wide ? (
    <td className={`${td} w-[1.4em] text-center`}>
      <span className="inline-block size-[0.8em] border border-black/50 align-middle" />
    </td>
  ) : null;
  const sumsRow = (label: string, s: Sums, className: string) => (
    <tr style={row} className={className}>
      <td className={td} colSpan={withCompany ? 3 : 2}>
        {label}
      </td>
      <td className={num}>{dz(s.dz)}</td>
      <td className={td} />
      <td className={num}>{s.discount.isZero() ? "" : formatMoney(s.discount.toFixed(2))}</td>
      <td className={num}>{formatMoney(s.amount.toFixed(2))}</td>
      {wide ? <td className={td} /> : null}
    </tr>
  );

  return (
    <div className="leading-snug text-black [print-color-adjust:exact]">
      {pages.map((pageLines, p) => {
        const first = p === 0;
        const last = p === pages.length - 1;
        const offset = pages.slice(0, p).reduce((n, pg) => n + pg.length, 0);
        return (
          <section
            key={p}
            aria-label={pages.length > 1 ? `Page ${p + 1} of ${pages.length}` : undefined}
            className="flex flex-col not-first:mt-[10mm] not-first:border-t not-first:border-dashed not-first:border-black/40 not-first:pt-[4mm] print:break-after-page print:not-first:mt-0 print:not-first:border-0 print:not-first:pt-0 print:last:break-after-auto"
            style={pagination ? { height: `${pagination.pageHeightMm - 0.5}mm` } : undefined}
          >
            {first ? (
              <>
                {/* Letterhead left; the bill's number, date and order right. */}
                <header className="flex items-start justify-between gap-4 border-b-[1.5px] border-black pb-[0.35em]">
                  <div className="flex min-w-0 items-center gap-[0.6em]">
                    {business.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- a stored data: URL; next/image adds nothing here
                      <img
                        src={business.logoUrl}
                        alt=""
                        className="h-[2.6em] w-auto max-w-[7em] object-contain"
                      />
                    ) : null}
                    <div className="min-w-0">
                      <p className="text-[1.25em] leading-tight font-bold">{business.name}</p>
                      <p className={`${MUTED} truncate`}>
                        {[business.address, business.phone].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="leading-tight">{billNo}</p>
                    <p className={MUTED}>
                      {formatDate(view.bill.billDate)} · Order #{view.order.number}
                    </p>
                  </div>
                </header>
                {/* Who it is billed to; how the goods went (and how it was paid). */}
                <div className="flex items-start justify-between gap-4 border-b border-black/30 py-[0.4em]">
                  <div className="min-w-0">
                    <p className="truncate">
                      <span className={LABEL}>Bill to</span>{" "}
                      <span className="font-bold">{view.customer.name}</span>
                      {view.customer.shopName ? (
                        <span className="text-[0.9em] text-black/70">
                          {" "}
                          · {view.customer.shopName}
                        </span>
                      ) : null}
                    </p>
                    {customerLine ? <p className={`${MUTED} truncate`}>{customerLine}</p> : null}
                  </div>
                  <p className={`${MUTED} shrink-0`}>{sale}</p>
                </div>
                {title ? <p className="pt-[0.3em] font-bold">{title}</p> : null}
              </>
            ) : (
              // Later pages: just enough to tell whose bill it is.
              <header className="flex items-start justify-between gap-4 border-b-[1.5px] border-black pb-[0.35em]">
                <div className="min-w-0">
                  <p className="font-bold">{business.name}</p>
                  <p className={`${MUTED} truncate`}>
                    {[view.customer.name, view.customer.shopName, view.customer.areaName]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="leading-tight">{billNo}</p>
                  <p className={MUTED}>{formatDate(view.bill.billDate)} · continued</p>
                </div>
              </header>
            )}

            <table className="mt-[0.5em] w-full border-collapse">
              <thead>
                <tr className="border-b border-black">
                  <th className={`${th} w-[2em]`}>#</th>
                  <th className={`${th} w-full`}>Item</th>
                  {withCompany ? <th className={th}>Company</th> : null}
                  <th className={`${th} text-right`}>Dz</th>
                  <th className={`${th} text-right`}>Rate</th>
                  <th className={`${th} text-right`}>Disc.</th>
                  <th className={`${th} text-right`}>Amount</th>
                  {wide ? <th className={`${th} text-center`}>✓</th> : null}
                </tr>
              </thead>
              <tbody>
                {first
                  ? null
                  : sumsRow(
                      `Brought forward from page ${p}`,
                      starts[p]!,
                      "bg-black/[0.07] font-semibold",
                    )}
                {pageLines.map((l, i) => (
                  <tr key={l.productId} style={row} className="even:bg-black/[0.035]">
                    <td className={`${td} text-black/60 tabular-nums`}>{offset + i + 1}</td>
                    <td className={`${td} max-w-0 truncate`} title={`${l.code} ${l.name}`}>
                      {l.name}
                    </td>
                    {withCompany ? (
                      <td className={`${td} text-[0.9em]`}>
                        {/* A cell's max-width is ignored in a table: the box inside caps it. */}
                        <div className="max-w-[8em] truncate">{l.companyName}</div>
                      </td>
                    ) : null}
                    <td className={`${num} font-semibold`}>{dz(l.quantity)}</td>
                    <td className={num}>{formatMoney(l.rate)}</td>
                    <td className={`${num} text-black/70`}>
                      {new Decimal(l.discountAmount).isZero() ? "—" : formatMoney(l.discountAmount)}
                    </td>
                    <td className={`${num} font-semibold`}>{formatMoney(gross(l).toFixed(2))}</td>
                    {tick}
                  </tr>
                ))}
                {last
                  ? null
                  : sumsRow(
                      `Carried forward to page ${p + 2}`,
                      starts[p + 1]!,
                      "border-y border-black bg-black/[0.07] font-semibold",
                    )}
              </tbody>
              {last ? (
                <tfoot>
                  {sumsRow(
                    `${lines.length} ${lines.length === 1 ? "item" : "items"}`,
                    totals,
                    "border-y-[1.5px] border-black font-bold",
                  )}
                </tfoot>
              ) : null}
            </table>

            {last ? (
              // The customer's account on the left; subtotal, discount and This bill on the right.
              <div className="mt-[0.7em] flex items-start justify-between gap-x-6">
                <dl className="grid w-[17em] max-w-[48%] grid-cols-[1fr_auto] gap-y-[0.05em] text-[0.9em] [&>dd]:pl-3 [&>dd]:text-right [&>dd]:tabular-nums">
                  <dt className={`${LABEL} col-span-2 mb-[0.15em]`}>Account</dt>
                  {hasOld ? (
                    <>
                      <dt>Old balance</dt>
                      <dd>{formatMoney(oldBalance)}</dd>
                      <dt>Previous pending</dt>
                      <dd>
                        {formatMoney(
                          new Decimal(previous.toString()).sub(oldBalance.toString()).toFixed(2),
                        )}
                      </dd>
                    </>
                  ) : (
                    <>
                      <dt>Previous balance</dt>
                      <dd>{formatMoney(previous)}</dd>
                    </>
                  )}
                  <dt>This bill</dt>
                  <dd>+{formatMoney(thisBill)}</dd>
                  {paid && !paidAmount.isZero() ? (
                    <>
                      <dt>{paidLabel(paid)}</dt>
                      <dd>−{formatMoney(paidAmount.toFixed(2))}</dd>
                    </>
                  ) : null}
                  <dt className="mt-[0.3em] border-t border-black pt-[0.25em] text-[0.85em] font-bold tracking-[0.08em] uppercase">
                    Balance due
                  </dt>
                  <dd className="mt-[0.3em] border-t border-black pt-[0.15em] text-[1.25em] font-bold">
                    {formatMoney(balance.toFixed(2))}
                  </dd>
                  {minimum && !new Decimal(minimum.toString()).isZero() ? (
                    <>
                      <dt className="text-[0.9em] text-black/70">Minimum payment</dt>
                      <dd className="text-[0.9em] text-black/70">{formatMoney(minimum)}</dd>
                    </>
                  ) : null}
                </dl>
                <dl className="grid w-[16em] max-w-[48%] grid-cols-[1fr_auto] gap-y-[0.05em] text-[0.9em] [&>dd]:text-right [&>dd]:tabular-nums">
                  <dt>Subtotal</dt>
                  <dd>{formatMoney(totals.amount.toFixed(2))}</dd>
                  {!totals.discount.isZero() ? (
                    <>
                      <dt>Discount</dt>
                      <dd>−{formatMoney(totals.discount.toFixed(2))}</dd>
                    </>
                  ) : null}
                  {/* What the customer pays for these goods: the biggest figure, in a box. */}
                  <div className="col-span-2 mt-[0.45em] flex items-baseline justify-between gap-3 border-[1.5px] border-black px-[0.6em] py-[0.35em]">
                    <dt className="text-[0.85em] font-bold tracking-[0.1em] uppercase">
                      This bill
                    </dt>
                    <dd className="text-[1.35em] leading-tight font-bold tabular-nums">
                      Rs {formatMoney(thisBill)}
                    </dd>
                  </div>
                </dl>
              </div>
            ) : null}

            {pagination || business.billNote ? (
              <footer className="mt-auto flex items-end justify-between gap-4 border-t border-black/25 pt-[0.35em] text-[0.8em] text-black/70">
                <p className="min-w-0 truncate">
                  {last
                    ? (business.billNote ?? "")
                    : `Continued on page ${p + 2} — totals on the last page.`}
                </p>
                {pagination ? (
                  <p className="shrink-0 tabular-nums">
                    Page {p + 1} of {pages.length}
                  </p>
                ) : null}
              </footer>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

/**
 * The short bill for small paper (A6, receipt rolls): one-line letterhead and customer, short
 * product names, each line at its full rate, no company column; under the total the discount
 * is taken off ("This bill"), then previous and total due. Same figures as the full bill.
 */
export function CompactBillDocument({
  view,
  business,
  title,
  lines,
  thisBill,
  previous,
  totalDue,
  minimum,
  paid,
}: {
  view: BillView;
  business: PrintProfile["business"];
  title?: string;
  lines: Line[];
  thisBill: { toString(): string };
  previous: { toString(): string };
  totalDue: { toString(): string };
  minimum?: { toString(): string };
  /** Paid with the order (full bill only): shown with the balance left. */
  paid?: Paid;
}) {
  const dz = formatDozensCell;
  const paidAmount = paid ? new Decimal(paid.amount.toString()) : new Decimal(0);
  // Each line at its full rate; the company discount is taken off once, under the total (as on
  // the office's old bills: total, "T/O less", net).
  const gross = (l: Line) => new Decimal(l.netAmount).add(l.discountAmount);
  const grossTotal = lines.reduce((s, l) => s.add(gross(l)), new Decimal(0));
  const discount = lines.reduce((s, l) => s.add(l.discountAmount), new Decimal(0));
  const customer = [view.customer.shopName, view.customer.areaName, view.customer.phone]
    .filter(Boolean)
    .join(" · ");
  return (
    <article className="space-y-[0.35em] leading-tight">
      <header className="flex items-baseline justify-between gap-2 border-b border-black pb-[0.2em]">
        <div className="min-w-0">
          <p className="truncate font-bold">{business.name}</p>
          {business.phone ? <p className="text-[0.85em]">{business.phone}</p> : null}
        </div>
        <div className="shrink-0 text-right">
          <p className="font-bold">
            Bill #{view.bill.number}
            {view.bill.revision > 1 ? ` (rev ${view.bill.revision})` : ""}
          </p>
          <p className="text-[0.85em]">{formatDate(view.bill.billDate)}</p>
        </div>
      </header>
      <div>
        <p className="font-semibold">{view.customer.name}</p>
        {customer ? <p className="text-[0.85em]">{customer}</p> : null}
      </div>
      {title ? <p className="font-semibold">{title}</p> : null}
      <table className="w-full border-collapse [&_td:not(:first-child)]:pl-[0.5em] [&_th:not(:first-child)]:pl-[0.5em]">
        <thead>
          <tr className="border-b border-black text-left">
            <th className="font-semibold">Item</th>
            <th className="text-right font-semibold">Dz</th>
            <th className="text-right font-semibold">Rate</th>
            <th className="text-right font-semibold">Amt</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.productId} className="align-top">
              <td className="break-words">{l.shortName}</td>
              <td className="text-right whitespace-nowrap tabular-nums">{dz(l.quantity)}</td>
              <td className="text-right whitespace-nowrap tabular-nums">{formatMoney(l.rate)}</td>
              <td className="text-right whitespace-nowrap tabular-nums">
                {formatMoney(gross(l).toFixed(2))}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-black font-semibold">
            <td>Total</td>
            <td className="text-right whitespace-nowrap tabular-nums">
              {dz(lines.reduce((s, l) => s + l.quantity, 0))}
            </td>
            <td />
            <td className="text-right whitespace-nowrap tabular-nums">
              {formatMoney(grossTotal.toFixed(2))}
            </td>
          </tr>
        </tfoot>
      </table>
      <dl className="grid grid-cols-[1fr_auto] gap-x-2 text-right">
        {!discount.isZero() ? (
          <>
            <dt>Discount</dt>
            <dd className="tabular-nums">−{formatMoney(discount.toFixed(2))}</dd>
          </>
        ) : null}
        <dt className={THIS_BILL}>This bill</dt>
        <dd className={`${THIS_BILL} tabular-nums`}>{formatMoney(thisBill)}</dd>
        <dt className={SMALL}>Previous</dt>
        <dd className={`${SMALL} tabular-nums`}>{formatMoney(previous)}</dd>
        <dt className={`${SMALL} font-semibold`}>Total due</dt>
        <dd className={`${SMALL} font-semibold tabular-nums`}>{formatMoney(totalDue)}</dd>
        {paid && !paidAmount.isZero() ? (
          <>
            <dt className={SMALL}>{paidLabel(paid)}</dt>
            <dd className={`${SMALL} tabular-nums`}>−{formatMoney(paidAmount.toFixed(2))}</dd>
            <dt className="font-bold">Balance due</dt>
            <dd className="font-bold tabular-nums">
              {formatMoney(new Decimal(totalDue.toString()).sub(paidAmount).toFixed(2))}
            </dd>
          </>
        ) : null}
        {minimum ? (
          <>
            <dt className={SMALL}>Minimum payment</dt>
            <dd className={`${SMALL} tabular-nums`}>{formatMoney(minimum)}</dd>
          </>
        ) : null}
      </dl>
    </article>
  );
}

/**
 * The documents for one bill: the full bill, or one per company when split; compact or full as
 * the print settings say, and laid out in pages when printed one per sheet.
 */
export function billDocuments(
  view: BillView,
  business: PrintProfile["business"],
  split: boolean,
  settings: PrintSettings,
) {
  const pagination = billPagination(settings);
  if (usesCompactBill(settings)) {
    if (!split)
      return [
        {
          key: view.bill.id,
          node: (
            <CompactBillDocument
              view={view}
              business={business}
              lines={view.lines}
              thisBill={view.bill.netAmount}
              previous={view.previous}
              totalDue={view.totalDue}
              minimum={view.minimumPayment}
              paid={view.paid}
            />
          ),
        },
      ];
    return view.sections.map((s) => ({
      key: `${view.bill.id}-${s.companyId}`,
      node: (
        <CompactBillDocument
          view={view}
          business={business}
          title={s.companyName}
          lines={s.lines}
          thisBill={s.thisBill}
          previous={s.previous}
          totalDue={s.totalDue}
        />
      ),
    }));
  }
  if (!split) {
    return [
      {
        key: view.bill.id,
        node: (
          <BillDocument
            view={view}
            business={business}
            lines={view.lines}
            thisBill={view.bill.netAmount}
            previous={view.previous}
            oldBalance={view.oldBalance}
            totalDue={view.totalDue}
            minimum={view.minimumPayment}
            paid={view.paid}
            showCompany={view.sections.length > 1}
            pagination={pagination}
          />
        ),
      },
    ];
  }
  return view.sections.map((s) => ({
    key: `${view.bill.id}-${s.companyId}`,
    node: (
      <BillDocument
        view={view}
        business={business}
        title={`${s.companyName} portion`}
        lines={s.lines}
        thisBill={s.thisBill}
        previous={s.previous}
        totalDue={s.totalDue}
        showCompany={false}
        pagination={pagination}
      />
    ),
  }));
}
