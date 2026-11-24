import type { Metadata } from "next";

import { AutoPrint } from "@/components/layout/print-button";
import { PrintStyles, PrintToolbar } from "@/components/print/print-frame";
import { formatDateTime, formatMoney } from "@/lib/format";
import { filterParam } from "@/lib/list-params";
import { formatDozensCell } from "@/lib/units";
import { requireTenantContext } from "@/server/auth/session";
import { stockReport } from "@/server/services/inventory";
import { companyOptions } from "@/server/services/master/companies";
import { warehouseOptions } from "@/server/services/master/warehouses";
import { getPrintProfile } from "@/server/services/settings";

export const metadata: Metadata = { title: "Stock report" };

// The printed stock report: every product (not one screen page), grouped by company, on A4. The
// page margin is zero, so the browser has no room for its own header and footer (date, title,
// address); the white border is padding on the sheet instead, and spacer rows in the table's
// head and foot (which the browser repeats on every page) give each page its top and bottom
// margin. The business name, title and date repeat at the top of each page with the column
// headings. Black and white only.

const CSS = `
@page { size: A4 portrait; margin: 0; }
.stock-sheet { width: 210mm; max-width: 100%; padding: 12mm 12mm 14mm; font-size: 8.5pt; line-height: 1.25; }
.stock-sheet .spacer { display: none; }
@media print {
  .stock-sheet { padding: 0 11mm; max-width: none; }
  .stock-sheet .spacer { display: table-row; }
  .stock-sheet .spacer td { padding: 0; border: 0; }
  .stock-sheet .top td { height: 9mm; }
  .stock-sheet .bottom td { height: 8mm; }
  .stock-sheet tbody tr { break-inside: avoid; }
}
`;

const th =
  "px-[1.2mm] py-[1mm] font-semibold text-[7pt] uppercase tracking-[0.05em] whitespace-nowrap";
const td = "px-[1.2mm] py-[0.75mm] align-middle";
const num = "text-right tabular-nums whitespace-nowrap";

export default async function StockReportPage({ searchParams }: PageProps<"/inventory/print">) {
  const sp = await searchParams;
  const ctx = await requireTenantContext("operations.manage");
  const filters = {
    q: filterParam(sp, "q"),
    warehouseId: filterParam(sp, "warehouseId"),
    companyId: filterParam(sp, "companyId"),
    low: filterParam(sp, "level") === "low",
  };
  const [report, profile, warehouses, companies] = await Promise.all([
    stockReport(ctx, filters),
    getPrintProfile(ctx),
    warehouseOptions(ctx),
    companyOptions(ctx),
  ]);
  const now = new Date();
  const back = new URLSearchParams(
    Object.entries({
      q: filters.q,
      warehouseId: filters.warehouseId,
      companyId: filters.companyId,
      level: filters.low ? "low" : undefined,
    }).filter((e): e is [string, string] => Boolean(e[1])),
  ).toString();
  // What this copy covers, when it is not everything.
  const scope = [
    filters.warehouseId ? warehouses.find((w) => w.id === filters.warehouseId)?.name : null,
    filters.companyId ? companies.find((c) => c.id === filters.companyId)?.name : null,
    filters.low ? "Below minimum only" : null,
    filters.q ? `Matching “${filters.q}”` : null,
  ].filter(Boolean);
  const v = report.showValue;
  const columns = v ? 10 : 9;
  const dz = (packets: number) => formatDozensCell(packets);
  const blank = (packets: number) => (packets ? dz(packets) : "");
  const business = profile.business;

  return (
    <div>
      <PrintStyles css={CSS} />
      <PrintToolbar
        back={{ href: `/inventory${back ? `?${back}` : ""}`, label: "Inventory" }}
        hint="A4 portrait · no browser header or footer"
      />
      <article className="stock-sheet paper mx-auto border bg-white text-black shadow-sm [print-color-adjust:exact] print:mx-0 print:border-0 print:shadow-none">
        <table className="w-full border-collapse">
          <thead>
            <tr className="spacer top">
              <td colSpan={columns} />
            </tr>
            <tr>
              <td colSpan={columns} className="pb-[2mm]">
                <div className="flex items-end justify-between gap-4 border-b-[1.5px] border-black pb-[1.5mm]">
                  <div className="min-w-0">
                    <p className="text-[13pt] leading-tight font-bold">{business.name}</p>
                    <p className="truncate text-[7.5pt] text-black/70">
                      {[business.address, business.phone].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-[7pt] font-semibold tracking-[0.3em] text-black/60">
                      STOCK REPORT
                    </p>
                    <p className="text-[9pt] font-semibold">As of {formatDateTime(now)}</p>
                    {scope.length ? (
                      <p className="text-[7.5pt] text-black/70">{scope.join(" · ")}</p>
                    ) : null}
                  </div>
                </div>
              </td>
            </tr>
            <tr className="border-y border-black bg-black/[0.07] text-left">
              <th className={`${th} w-[7mm] text-right`}>#</th>
              <th className={`${th} w-[16mm]`}>Code</th>
              <th className={`${th} w-full`}>Product</th>
              <th className={`${th} text-right`}>On hand</th>
              <th className={`${th} text-right`}>Reserved</th>
              <th className={`${th} text-right`}>Available</th>
              <th className={`${th} text-right`}>Damaged</th>
              <th className={`${th} text-right`}>Min</th>
              {v ? <th className={`${th} text-right`}>Value</th> : null}
              <th className={`${th} w-[17mm] text-center`}>Count</th>
            </tr>
          </thead>
          <tfoot>
            <tr className="spacer bottom">
              <td colSpan={columns} />
            </tr>
          </tfoot>
          {report.groups.length === 0 ? (
            <tbody>
              <tr>
                <td colSpan={columns} className={`${td} py-[4mm] text-center`}>
                  No products match these filters.
                </td>
              </tr>
            </tbody>
          ) : null}
          {report.groups.map((g, gi) => {
            const start = report.groups.slice(0, gi).reduce((n, x) => n + x.rows.length, 0);
            return (
              <tbody key={g.companyName}>
                <tr className="border-b border-black/70 bg-black/[0.035] font-bold">
                  <td className={td} colSpan={3}>
                    {g.companyName}
                    <span className="ml-[2mm] text-[7.5pt] font-normal text-black/65">
                      {g.rows.length} {g.rows.length === 1 ? "item" : "items"}
                      {report.warehouses > 1 ? ` · ${g.warehouseName}` : ""}
                    </span>
                  </td>
                  <td className={`${td} ${num}`}>{dz(g.onHand)}</td>
                  <td className={`${td} ${num}`}>{blank(g.reserved)}</td>
                  <td className={`${td} ${num}`}>{dz(g.available)}</td>
                  <td className={`${td} ${num}`}>{blank(g.damaged)}</td>
                  <td className={td} />
                  {v ? <td className={`${td} ${num}`}>{formatMoney(g.value)}</td> : null}
                  <td className={td} />
                </tr>
                {g.rows.map((r, i) => (
                  <tr key={r.id} className="border-b border-dotted border-black/45">
                    <td className={`${td} ${num} text-black/60`}>{start + i + 1}</td>
                    <td className={`${td} font-mono text-[7.5pt] whitespace-nowrap text-black`}>
                      {r.code}
                    </td>
                    <td className={td}>{r.name}</td>
                    <td className={`${td} ${num}`}>{dz(r.onHand)}</td>
                    <td className={`${td} ${num}`}>{blank(r.reserved)}</td>
                    <td className={`${td} ${num} font-semibold`}>
                      {dz(r.available)}
                      {r.low ? (
                        <span className="ml-[1mm] border border-black px-[0.6mm] text-[6pt] font-bold">
                          LOW
                        </span>
                      ) : null}
                    </td>
                    <td className={`${td} ${num}`}>{blank(r.damaged)}</td>
                    <td className={`${td} ${num} text-black/70`}>{blank(r.minStockLevel)}</td>
                    {v ? <td className={`${td} ${num}`}>{formatMoney(r.value)}</td> : null}
                    <td className={td}>
                      <span className="block h-[3.2mm] border-b border-black/50" />
                    </td>
                  </tr>
                ))}
              </tbody>
            );
          })}
          {report.groups.length > 0 ? (
            <tbody>
              <tr className="border-t-[1.5px] border-b-[1.5px] border-black text-[9pt] font-bold">
                <td className={td} colSpan={3}>
                  Total · {report.count} {report.count === 1 ? "product" : "products"}
                </td>
                <td className={`${td} ${num}`}>{dz(report.totals.onHand)}</td>
                <td className={`${td} ${num}`}>{blank(report.totals.reserved)}</td>
                <td className={`${td} ${num}`}>{dz(report.totals.available)}</td>
                <td className={`${td} ${num}`}>{blank(report.totals.damaged)}</td>
                <td className={td} />
                {v ? <td className={`${td} ${num}`}>{formatMoney(report.totals.value)}</td> : null}
                <td className={td} />
              </tr>
              <tr>
                <td colSpan={columns} className="pt-[3mm] text-[7.5pt] text-black/75">
                  <div className="flex items-end justify-between gap-6">
                    <p>
                      Quantities in dozens (pk = packets). Available = on hand − reserved for booked
                      orders.
                      {report.totals.low ? ` LOW = below minimum (${report.totals.low}).` : ""}
                      {v ? " Value = on hand at today's purchase rate." : ""}
                    </p>
                    <p className="shrink-0 whitespace-nowrap">
                      Checked by ____________________ &nbsp; Date ____________
                    </p>
                  </div>
                </td>
              </tr>
            </tbody>
          ) : null}
        </table>
      </article>
      {filterParam(sp, "print") === "1" ? <AutoPrint /> : null}
    </div>
  );
}
