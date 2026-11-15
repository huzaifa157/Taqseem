"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { formatMoney } from "@/lib/format";
import { localPhone } from "@/lib/phone";
import { billTotals, priceLineFor } from "@/lib/sales";
import { cn } from "@/lib/utils";
import { formatDozens, PACKETS_PER_HALF_DOZEN, parseQuantity } from "@/lib/units";
import { bookBulkOrdersAction, saveBulkOrderLayoutAction } from "@/server/sales-actions";
import type { BulkOrderSheet, BulkRowResult } from "@/server/services/sales/bulk-orders";

import { Combobox, rankText } from "./combobox";

type Product = BulkOrderSheet["products"][number];
type Customer = BulkOrderSheet["customers"][number];

/** One customer's order: dozens typed per product (by product id). */
type Row = {
  key: string;
  requestId: string;
  customerId: string;
  qty: Record<string, string>;
  result?: BulkRowResult;
};

const SOURCES = [
  { value: "OFFICE", label: "Office (booker call)" },
  { value: "WHATSAPP", label: "WhatsApp" },
  { value: "BOOKER_APP", label: "Booker app" },
];
const START_ROWS = 15;
/** Rows sent per request (the server books at most 100). */
const BATCH = 50;
const DRAFT_VERSION = 1;

const newRow = (): Row => ({
  key: crypto.randomUUID(),
  requestId: crypto.randomUUID(),
  customerId: "",
  qty: {},
});

/** Whole or half dozens → packets; null for blank; NaN for anything else. */
function packetsOf(text: string | undefined): number | null {
  if (!text || !text.trim()) return null;
  const packets = parseQuantity(text);
  return packets && packets % PACKETS_PER_HALF_DOZEN === 0 ? packets : Number.NaN;
}

const columnLabel = (p: Product) => p.shortName || p.code;

/** Customer and amount stay on screen while the products scroll across. */
const CUSTOMER_COL = "sticky left-0 w-64 min-w-64 max-w-64";
const AMOUNT_COL = "sticky left-64 w-32 min-w-32 border-r";

type Draft = {
  savedAt?: string;
  orderDate?: string;
  deliveryDate?: string;
  source?: string;
  rows: Row[];
};

const noSubscribe = () => () => {};

function readDraft(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** A sheet left in this browser, if it has anything typed in it. */
function parseDraft(text: string | null): Draft | null {
  if (!text) return null;
  try {
    const d = JSON.parse(text);
    if (d?.v !== DRAFT_VERSION || !Array.isArray(d.rows)) return null;
    const used = (d.rows as Row[]).some(
      (r) => r.customerId || Object.values(r.qty ?? {}).some((q) => String(q).trim()),
    );
    return used ? (d as Draft) : null;
  } catch {
    return null;
  }
}

/**
 * Bulk order entry for one warehouse: customers down, products across, dozens in the cells, as
 * the order booker reports them. Each row is booked as its own order (fixed rates, the customer's
 * own discounts, credit and stock checks as on the order screen). The unsaved sheet is kept in this
 * browser, so a reload or a dropped connection loses nothing.
 */
export function BulkOrderEntry({
  sheet,
  warehouses,
  canOverrideCredit,
  initial,
}: {
  sheet: BulkOrderSheet;
  warehouses: { id: string; name: string }[];
  canOverrideCredit: boolean;
  initial: { orderDate: string; deliveryDate: string };
}) {
  const router = useRouter();
  const warehouseId = sheet.warehouse.id;
  const draftKey = `taqseem:bulk-orders:${warehouseId}`;
  const products = sheet.products;
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const customerById = useMemo(
    () => new Map(sheet.customers.map((c) => [c.id, c])),
    [sheet.customers],
  );
  const discountOf = useMemo(() => {
    const m = new Map(sheet.discounts.map(([c, p, d]) => [`${c}|${p}`, d]));
    return (customerId: string, productId: string) => m.get(`${customerId}|${productId}`) ?? null;
  }, [sheet.discounts]);

  const [orderDate, setOrderDate] = useState(initial.orderDate);
  const [deliveryDate, setDeliveryDate] = useState(initial.deliveryDate);
  const [source, setSource] = useState("OFFICE");
  const [allowOver, setAllowOver] = useState(false);
  const [companyId, setCompanyId] = useState("");
  const [columns, setColumns] = useState<string[]>(sheet.columns ?? products.map((p) => p.id));
  const [editingColumns, setEditingColumns] = useState(false);
  const [rows, setRows] = useState<Row[]>(() => Array.from({ length: START_ROWS }, newRow));
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [booking, startBooking] = useTransition();
  const gridRef = useRef<HTMLTableElement>(null);

  // The unsaved sheet of this warehouse is kept in this browser (never needed for correctness).
  // A sheet left from before is offered (Restore / Discard) until something is typed; from then
  // on every change is kept.
  const [touched, setTouched] = useState(false);
  const [draftDismissed, setDraftDismissed] = useState(false);
  const draftText = useSyncExternalStore(
    noSubscribe,
    () => readDraft(draftKey),
    () => null,
  );
  const draft = useMemo(() => parseDraft(draftText), [draftText]);
  const offerDraft = !touched && !draftDismissed && draft !== null;
  useEffect(() => {
    if (!touched) return;
    try {
      const used = rows.some((r) => r.customerId || Object.values(r.qty).some((q) => q.trim()));
      if (used)
        localStorage.setItem(
          draftKey,
          JSON.stringify({
            v: DRAFT_VERSION,
            savedAt: new Date().toISOString(),
            orderDate,
            deliveryDate,
            source,
            rows,
          }),
        );
      else localStorage.removeItem(draftKey);
    } catch {}
  }, [draftKey, touched, rows, orderDate, deliveryDate, source]);
  const restoreDraft = () => {
    if (!draft) return;
    setRows(draft.rows);
    setOrderDate(draft.orderDate ?? orderDate);
    setDeliveryDate(draft.deliveryDate ?? deliveryDate);
    setSource(draft.source ?? source);
    setTouched(true);
  };
  const discardDraft = () => {
    try {
      localStorage.removeItem(draftKey);
    } catch {}
    setDraftDismissed(true);
  };

  const companies = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of products) m.set(p.companyId, p.companyName);
    return [...m];
  }, [products]);
  const shown = columns
    .map((id) => productById.get(id))
    .filter((p): p is Product => !!p && (!companyId || p.companyId === companyId));

  const usedCustomers = new Map<string, number>();
  for (const r of rows)
    if (r.customerId) usedCustomers.set(r.customerId, (usedCustomers.get(r.customerId) ?? 0) + 1);

  // Live figures: each row's total and every column's dozens against the stock free to sell.
  const rowInfo = rows.map((r) => {
    const lines = [];
    let invalid = 0;
    for (const [productId, text] of Object.entries(r.qty)) {
      const product = productById.get(productId);
      const packets = packetsOf(text);
      if (!product || packets === null) continue;
      if (Number.isNaN(packets)) {
        invalid++;
        continue;
      }
      lines.push(priceLineFor(product, packets, discountOf(r.customerId, productId)));
    }
    return { lines, invalid, total: billTotals(lines).total.netAmount };
  });
  const columnPackets = new Map<string, number>();
  rows.forEach((r, i) => {
    if (r.result?.ok) return; // booked: already reserved in "available"
    for (const l of rowInfo[i]!.lines)
      columnPackets.set(l.productId, (columnPackets.get(l.productId) ?? 0) + l.quantity);
  });
  const pendingRows = rows.filter((r, i) => !r.result?.ok && rowInfo[i]!.lines.length > 0);
  const sheetTotal = rows.reduce(
    (sum, r, i) => (r.result?.ok ? sum : sum + Number(rowInfo[i]!.total.toString())),
    0,
  );
  const booked = rows.filter((r) => r.result?.ok);

  const update = (key: string, change: (r: Row) => Row) => {
    setTouched(true);
    setRows((all) => {
      const next = all.map((r) =>
        r.key === key
          ? // Editing a row that failed clears its message; the same requestId is kept.
            { ...change(r), result: r.result?.ok ? r.result : undefined }
          : r,
      );
      // Typing in the last row adds an empty one below.
      const last = next[next.length - 1];
      if (last && (last.customerId || Object.values(last.qty).some((q) => q.trim())))
        next.push(newRow());
      return next;
    });
  };

  /** Moves focus within the sheet: column 0 is the customer, 1… the shown products. */
  const focusCell = (row: number, col: number) => {
    const grid = gridRef.current;
    if (!grid) return;
    if (row >= rows.length) setRows((all) => [...all, newRow()]);
    requestAnimationFrame(() => {
      const el = grid.querySelector<HTMLElement>(`[data-cell="${row}:${col}"]`);
      el?.focus();
      if (el instanceof HTMLInputElement) el.select();
    });
  };

  const cellKeys = (e: React.KeyboardEvent<HTMLElement>, row: number, col: number) => {
    const input = e.currentTarget instanceof HTMLInputElement ? e.currentTarget : null;
    const atStart = !input || (input.selectionStart === 0 && input.selectionEnd === 0);
    const atEnd = !input || input.selectionStart === input.value.length;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      book();
    } else if (e.key === "ArrowDown" || (e.key === "Enter" && !e.shiftKey)) {
      e.preventDefault();
      focusCell(row + 1, col);
    } else if (e.key === "ArrowUp" || (e.key === "Enter" && e.shiftKey)) {
      e.preventDefault();
      if (row > 0) focusCell(row - 1, col);
    } else if (e.key === "ArrowRight" && atEnd && col < shown.length) {
      e.preventDefault();
      focusCell(row, col + 1);
    } else if (e.key === "ArrowLeft" && atStart && col > 0) {
      e.preventDefault();
      focusCell(row, col - 1);
    }
  };

  function book() {
    if (booking) return;
    setMessage(null);
    const problems: string[] = [];
    rows.forEach((r, i) => {
      if (r.result?.ok) return;
      const info = rowInfo[i]!;
      if (info.invalid) problems.push(`row ${i + 1}: dozens must be whole or half (e.g. 2 or 1.5)`);
      else if (info.lines.length && !r.customerId)
        problems.push(`row ${i + 1}: choose the customer`);
    });
    if (problems.length) {
      setMessage({ tone: "error", text: `Nothing booked yet. Fix ${problems.join("; ")}.` });
      return;
    }
    const toBook = rows
      .map((r, i) => ({ r, info: rowInfo[i]! }))
      .filter(({ r, info }) => !r.result?.ok && r.customerId && info.lines.length > 0);
    if (!toBook.length) {
      setMessage({ tone: "error", text: "Enter a customer and at least one quantity first." });
      return;
    }
    startBooking(async () => {
      const results = new Map<string, BulkRowResult>();
      let failure: string | null = null;
      for (let i = 0; i < toBook.length && !failure; i += BATCH) {
        const batch = toBook.slice(i, i + BATCH);
        try {
          const res = await bookBulkOrdersAction({
            warehouseId,
            orderDate,
            deliveryDate,
            source,
            allowOverCredit: allowOver,
            rows: batch.map(({ r }) => ({
              requestId: r.requestId,
              customerId: r.customerId,
              lines: Object.entries(r.qty)
                .filter(([, q]) => q.trim())
                .map(([productId, quantity]) => ({ productId, quantity: quantity.trim() })),
            })),
          });
          if ("error" in res) failure = res.error;
          else for (const result of res.results) results.set(result.requestId, result);
        } catch {
          // Weak internet: whatever was booked keeps its requestId, so booking again is safe.
          failure =
            "The connection dropped. Press Book again: rows already booked are not repeated.";
        }
      }
      setRows((all) =>
        all.map((r) => (results.has(r.requestId) ? { ...r, result: results.get(r.requestId) } : r)),
      );
      const ok = [...results.values()].filter((r) => r.ok).length;
      const bad = [...results.values()].filter((r) => !r.ok).length;
      setMessage(
        failure
          ? { tone: "error", text: ok ? `${ok} booked. ${failure}` : failure }
          : bad
            ? {
                tone: "error",
                text: `${ok} ${ok === 1 ? "order" : "orders"} booked. ${bad} ${bad === 1 ? "row needs" : "rows need"} attention (shown in red).`,
              }
            : { tone: "ok", text: `${ok} ${ok === 1 ? "order" : "orders"} booked.` },
      );
      if (ok) router.refresh(); // fresh "available" stock
    });
  }

  const clearBooked = () => {
    setTouched(true);
    setRows((all) => {
      const left = all.filter((r) => !r.result?.ok);
      return left.length ? left : Array.from({ length: START_ROWS }, newRow);
    });
  };
  const clearSheet = () => {
    if (!window.confirm("Clear the whole sheet? Booked orders stay booked.")) return;
    setTouched(true);
    setRows(Array.from({ length: START_ROWS }, newRow));
    setMessage(null);
  };

  const hiddenCount = products.length - columns.filter((id) => productById.has(id)).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="bulk-warehouse">Warehouse</Label>
          <NativeSelect
            id="bulk-warehouse"
            value={warehouseId}
            onChange={(e) => router.push(`/orders/bulk?warehouse=${e.target.value}`)}
            className="w-44"
          >
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bulk-company">Company</Label>
          <NativeSelect
            id="bulk-company"
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
            className="w-44"
          >
            <option value="">All companies</option>
            {companies.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bulk-order-date">Order date</Label>
          <Input
            id="bulk-order-date"
            type="date"
            value={orderDate}
            onChange={(e) => {
              setTouched(true);
              setOrderDate(e.target.value);
            }}
            className="w-40"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bulk-delivery-date">Delivery date</Label>
          <Input
            id="bulk-delivery-date"
            type="date"
            value={deliveryDate}
            onChange={(e) => {
              setTouched(true);
              setDeliveryDate(e.target.value);
            }}
            className="w-40"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bulk-source">Received by</Label>
          <NativeSelect
            id="bulk-source"
            value={source}
            onChange={(e) => {
              setTouched(true);
              setSource(e.target.value);
            }}
            className="w-48"
          >
            {SOURCES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => setEditingColumns((v) => !v)}
          aria-expanded={editingColumns}
        >
          Columns{hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ""}
        </Button>
      </div>

      {offerDraft && draft ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-md border border-amber-500/60 bg-amber-500/10 px-3 py-2 text-sm"
        >
          <span>
            A sheet you had not booked is kept in this browser
            {draft.savedAt ? ` (${new Date(draft.savedAt).toLocaleString("en-PK")})` : ""}. Restore
            it before typing, or it is replaced.
          </span>
          <Button type="button" size="sm" onClick={restoreDraft}>
            Restore it
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={discardDraft}>
            Discard
          </Button>
        </div>
      ) : null}

      {editingColumns ? (
        <ColumnsPanel
          products={products}
          columns={columns}
          warehouseId={warehouseId}
          onSaved={(saved) => {
            setColumns(saved);
            setEditingColumns(false);
          }}
          onCancel={() => setEditingColumns(false)}
        />
      ) : null}

      {products.length === 0 ? (
        <p className="text-muted-foreground text-sm">This warehouse has no active products yet.</p>
      ) : (
        <div className="overflow-auto rounded-md border" style={{ maxHeight: "70vh" }}>
          <table ref={gridRef} className="w-max min-w-full border-collapse text-sm">
            <thead className="bg-muted sticky top-0 z-10">
              <tr>
                <th
                  scope="col"
                  className={cn(CUSTOMER_COL, "bg-muted z-20 px-2 py-2 text-left font-medium")}
                >
                  <span className="text-muted-foreground mr-3 inline-block w-5 text-right">#</span>
                  Customer
                </th>
                <th
                  scope="col"
                  className={cn(AMOUNT_COL, "bg-muted z-20 px-2 py-2 text-right font-medium")}
                >
                  Amount
                </th>
                {shown.map((p) => (
                  <th
                    key={p.id}
                    scope="col"
                    title={`${p.name} (${p.code}) · ${p.companyName} · Rs ${p.saleRate}/dz`}
                    className="w-16 px-1 py-2 text-center font-medium"
                  >
                    <span className="block max-w-16 truncate">{columnLabel(p)}</span>
                    <span className="text-muted-foreground block text-[11px] font-normal">
                      {Number(p.saleRate)}
                    </span>
                  </th>
                ))}
                <th scope="col" className="w-8 px-1 py-2">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const customer = customerById.get(r.customerId);
                const info = rowInfo[i]!;
                const done = r.result?.ok ? r.result : null;
                const failed = r.result && !r.result.ok ? r.result.error : null;
                const twice = (usedCustomers.get(r.customerId) ?? 0) > 1;
                return (
                  <BulkRow
                    key={r.key}
                    index={i}
                    row={r}
                    customer={customer}
                    customers={sheet.customers}
                    used={usedCustomers}
                    shown={shown}
                    discountOf={discountOf}
                    total={info.lines.length ? formatMoney(info.total) : ""}
                    done={done}
                    failed={failed ?? (twice ? "This customer is on the sheet twice." : null)}
                    onCustomer={(id) => {
                      update(r.key, (x) => ({ ...x, customerId: id }));
                      focusCell(i, 1);
                    }}
                    onQty={(productId, text) =>
                      update(r.key, (x) => ({ ...x, qty: { ...x.qty, [productId]: text } }))
                    }
                    onRemove={() =>
                      setRows((all) =>
                        all.length > 1 ? all.filter((x) => x.key !== r.key) : [newRow()],
                      )
                    }
                    cellKeys={cellKeys}
                  />
                );
              })}
            </tbody>
            <tfoot className="bg-muted sticky bottom-0 z-10 shadow-[0_-1px_0_var(--border)]">
              <tr>
                <th
                  scope="row"
                  className={cn(CUSTOMER_COL, "bg-muted px-2 py-1.5 text-left font-medium")}
                >
                  To book (dozens)
                </th>
                <td
                  className={cn(
                    AMOUNT_COL,
                    "bg-muted px-2 py-1.5 text-right font-medium tabular-nums",
                  )}
                >
                  {sheetTotal ? formatMoney(sheetTotal.toFixed(2)) : ""}
                </td>
                {shown.map((p) => {
                  const packets = columnPackets.get(p.id) ?? 0;
                  return (
                    <td key={p.id} className="px-1 py-1.5 text-center tabular-nums">
                      {packets ? formatDozens(packets).replace(" dz", "") : ""}
                    </td>
                  );
                })}
                <td />
              </tr>
              <tr>
                <th
                  scope="row"
                  className={cn(CUSTOMER_COL, "bg-muted px-2 py-1.5 text-left font-normal")}
                >
                  Free stock (dozens)
                </th>
                <td className={cn(AMOUNT_COL, "bg-muted")} />
                {shown.map((p) => {
                  const short = (columnPackets.get(p.id) ?? 0) > p.available;
                  return (
                    <td
                      key={p.id}
                      className={cn(
                        "px-1 py-1.5 text-center tabular-nums",
                        short ? "text-destructive font-semibold" : "text-muted-foreground",
                      )}
                      title={short ? "More is ordered than is free in stock" : undefined}
                    >
                      {formatDozens(Math.max(p.available, 0)).replace(" dz", "")}
                      {short ? <span className="sr-only"> (short)</span> : null}
                    </td>
                  );
                })}
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {message ? (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          className={cn(
            "rounded-md border px-3 py-2 text-sm",
            message.tone === "error" ? "border-destructive text-destructive" : "border-primary",
          )}
        >
          {message.text}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={book} disabled={booking || pendingRows.length === 0}>
          {booking
            ? "Booking…"
            : pendingRows.length
              ? `Book ${pendingRows.length} ${pendingRows.length === 1 ? "order" : "orders"}`
              : "Nothing to book"}
        </Button>
        {canOverrideCredit ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={allowOver}
              onChange={(e) => setAllowOver(e.target.checked)}
            />
            Allow past the credit limit
          </label>
        ) : null}
        <Button
          type="button"
          variant="outline"
          onClick={() => setRows((all) => [...all, ...Array.from({ length: 10 }, newRow)])}
        >
          Add 10 rows
        </Button>
        {booked.length ? (
          <>
            <Link
              href={`/orders/print?${booked.map((r) => `ids=${r.result!.ok ? r.result!.orderId : ""}`).join("&")}`}
              className="text-primary text-sm underline-offset-4 hover:underline"
            >
              Print the {booked.length} booked {booked.length === 1 ? "bill" : "bills"}
            </Link>
            <Button type="button" variant="ghost" onClick={clearBooked}>
              Clear booked rows
            </Button>
          </>
        ) : null}
        <Button type="button" variant="ghost" onClick={clearSheet}>
          Clear sheet
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        Type a customer and pick with <Kbd>Enter</Kbd>, then dozens in each product (whole or half,
        e.g. 2 or 1.5). <Kbd>Enter</Kbd> or <Kbd>↓</Kbd> moves down, <Kbd>Tab</Kbd> or <Kbd>→</Kbd>{" "}
        across, <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> books. Rates are fixed; each customer&apos;s own
        discounts apply (cells with one are underlined). Each row becomes its own order, with the
        usual credit and stock checks. This sheet is kept in this browser until booked or cleared.
      </p>
    </div>
  );
}

function BulkRow({
  index,
  row,
  customer,
  customers,
  used,
  shown,
  discountOf,
  total,
  done,
  failed,
  onCustomer,
  onQty,
  onRemove,
  cellKeys,
}: {
  index: number;
  row: Row;
  customer: Customer | undefined;
  customers: Customer[];
  used: Map<string, number>;
  shown: Product[];
  discountOf: (customerId: string, productId: string) => string | null;
  total: string;
  done: Extract<BulkRowResult, { ok: true }> | null;
  failed: string | null;
  onCustomer: (id: string) => void;
  onQty: (productId: string, text: string) => void;
  onRemove: () => void;
  cellKeys: (e: React.KeyboardEvent<HTMLElement>, row: number, col: number) => void;
}) {
  const locked = !!done;
  // Quantities typed in columns hidden by the company filter still belong to this order.
  const elsewhere = Object.entries(row.qty).filter(
    ([id, q]) => q.trim() && !shown.some((p) => p.id === id),
  ).length;
  return (
    <>
      <tr className={cn("border-t", done && "bg-primary/5", failed && "bg-destructive/5")}>
        <td className={cn(CUSTOMER_COL, "bg-background px-1 py-1")}>
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground w-6 shrink-0 text-right tabular-nums">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              {customer ? (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    data-cell={`${index}:0`}
                    disabled={locked}
                    onKeyDown={(e) => {
                      if (e.key === "Backspace" || e.key === "Delete") {
                        e.preventDefault();
                        onCustomer("");
                      } else cellKeys(e, index, 0);
                    }}
                    onClick={() => !locked && onCustomer("")}
                    title={locked ? undefined : "Change the customer (Backspace)"}
                    className="hover:bg-accent focus-visible:ring-ring/50 w-full truncate rounded px-2 py-1 text-left outline-none focus-visible:ring-[3px]"
                  >
                    <span className="font-medium">{customer.name}</span>
                    {customer.areaName ? (
                      <span className="text-muted-foreground"> · {customer.areaName}</span>
                    ) : null}
                  </button>
                  {customer.isFlagged ? <Badge variant="destructive">Flagged</Badge> : null}
                </div>
              ) : (
                <Combobox
                  label={`Customer, row ${index + 1}`}
                  hideLabel
                  floating
                  inputClassName="h-8"
                  items={customers.filter((c) => !used.has(c.id))}
                  getKey={(c) => c.id}
                  rank={(c, q) =>
                    rankText(q, null, c.name, c.shopName, c.phone, localPhone(c.phone), c.areaName)
                  }
                  render={(c) => (
                    <span className="flex justify-between gap-3">
                      <span>
                        {c.name}
                        {c.shopName ? (
                          <span className="text-muted-foreground"> · {c.shopName}</span>
                        ) : null}
                      </span>
                      <span className="text-muted-foreground">{c.areaName ?? "No area"}</span>
                    </span>
                  )}
                  onSelect={(c) => onCustomer(c.id)}
                  placeholder="Type a name…"
                  inputRef={(el) => {
                    if (el) el.dataset.cell = `${index}:0`;
                  }}
                  onInputKeyDown={(e, listOpen) => {
                    if (listOpen && ["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) return;
                    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "ArrowRight")
                      cellKeys(e, index, 0);
                  }}
                />
              )}
            </div>
          </div>
        </td>
        <td className={cn(AMOUNT_COL, "bg-background px-2 py-1 text-right tabular-nums")}>
          {done ? (
            <Link
              href={`/orders/${done.orderId}`}
              className="text-primary font-medium underline-offset-4 hover:underline"
            >
              #{done.number} · {formatMoney(done.amount)}
            </Link>
          ) : (
            <span>
              {total}
              {elsewhere ? (
                <span className="text-muted-foreground block text-[11px]">
                  + {elsewhere} in other companies
                </span>
              ) : null}
            </span>
          )}
        </td>
        {shown.map((p, c) => {
          const text = row.qty[p.id] ?? "";
          const packets = packetsOf(text);
          const bad = Number.isNaN(packets);
          const discount = row.customerId ? discountOf(row.customerId, p.id) : null;
          return (
            <td key={p.id} className="px-0.5 py-1">
              <input
                data-cell={`${index}:${c + 1}`}
                aria-label={`${p.name}, row ${index + 1}${customer ? `, ${customer.name}` : ""}`}
                aria-invalid={bad || undefined}
                title={
                  bad
                    ? "Whole or half dozens, e.g. 2 or 1.5"
                    : discount
                      ? `${customer?.name}'s discount: Rs ${discount}/dz`
                      : undefined
                }
                inputMode="decimal"
                autoComplete="off"
                readOnly={locked}
                value={text}
                onChange={(e) => onQty(p.id, e.target.value)}
                onKeyDown={(e) => cellKeys(e, index, c + 1)}
                onFocus={(e) => e.currentTarget.select()}
                className={cn(
                  "h-8 w-16 rounded border bg-transparent px-1 text-center tabular-nums outline-none",
                  "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
                  bad && "border-destructive text-destructive",
                  discount && "underline decoration-dotted underline-offset-4",
                  locked && "text-muted-foreground border-transparent",
                )}
              />
            </td>
          );
        })}
        <td className="px-1 py-1 text-center">
          {locked ? null : (
            <button
              type="button"
              onClick={onRemove}
              aria-label={`Remove row ${index + 1}`}
              className="text-muted-foreground hover:text-destructive rounded px-1"
            >
              ×
            </button>
          )}
        </td>
      </tr>
      {done && (done.needsCreditApproval || done.shortages.length) ? (
        <tr className={cn(done && "bg-primary/5")}>
          <td colSpan={shown.length + 3} className="px-2 pb-1 text-xs">
            <div className="sticky left-9 inline-flex flex-wrap items-center gap-2">
              {done.needsCreditApproval ? (
                <Badge variant="outline">Waiting for the owner: past the credit limit</Badge>
              ) : null}
              {done.shortages.length ? (
                <span className="text-muted-foreground">
                  Short in stock: {done.shortages.join(", ")}
                </span>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
      {failed ? (
        <tr className="bg-destructive/5">
          <td colSpan={shown.length + 3} className="text-destructive px-2 pb-1 text-xs">
            <div role="alert" className="sticky left-9 inline-block">
              {failed}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** Which products the sheet shows, in order; saved for the warehouse, for everyone. */
function ColumnsPanel({
  products,
  columns,
  warehouseId,
  onSaved,
  onCancel,
}: {
  products: Product[];
  columns: string[];
  warehouseId: string;
  onSaved: (columns: string[]) => void;
  onCancel: () => void;
}) {
  const byId = new Map(products.map((p) => [p.id, p]));
  const [list, setList] = useState(columns.filter((id) => byId.has(id)));
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const hidden = products.filter((p) => !list.includes(p.id));
  const move = (i: number, by: number) =>
    setList((l) => {
      const j = i + by;
      if (j < 0 || j >= l.length) return l;
      const next = [...l];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  return (
    <section aria-labelledby="columns-heading" className="bg-card space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="columns-heading" className="font-medium">
          Sheet columns
        </h2>
        <p className="text-muted-foreground text-xs">
          Put them in the order of the booker&apos;s list. Saved for this warehouse, for everyone.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <h3 className="mb-1 text-sm font-medium">On the sheet ({list.length})</h3>
          <ol className="max-h-80 space-y-1 overflow-auto">
            {list.map((id, i) => {
              const p = byId.get(id)!;
              return (
                <li key={id} className="flex items-center gap-2 rounded border px-2 py-1 text-sm">
                  <span className="text-muted-foreground w-6 text-right tabular-nums">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{columnLabel(p)}</span>{" "}
                    <span className="text-muted-foreground">
                      {p.name} · {p.companyName}
                    </span>
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => move(i, -1)}
                    disabled={i === 0}
                    aria-label={`Move ${p.name} up`}
                  >
                    ↑
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => move(i, 1)}
                    disabled={i === list.length - 1}
                    aria-label={`Move ${p.name} down`}
                  >
                    ↓
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setList((l) => l.filter((x) => x !== id))}
                    aria-label={`Hide ${p.name}`}
                  >
                    Hide
                  </Button>
                </li>
              );
            })}
          </ol>
        </div>
        <div>
          <h3 className="mb-1 text-sm font-medium">Not on the sheet ({hidden.length})</h3>
          {hidden.length ? (
            <ul className="max-h-80 space-y-1 overflow-auto">
              {hidden.map((p) => (
                <li key={p.id} className="flex items-center gap-2 rounded border px-2 py-1 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{columnLabel(p)}</span>{" "}
                    <span className="text-muted-foreground">
                      {p.name} · {p.companyName}
                    </span>
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setList((l) => [...l, p.id])}
                  >
                    Add
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">Every product is on the sheet.</p>
          )}
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={saving || list.length === 0}
          onClick={() =>
            startSaving(async () => {
              setError(null);
              const res = await saveBulkOrderLayoutAction(warehouseId, list);
              if ("error" in res) setError(res.error);
              else onSaved(res.columns);
            })
          }
        >
          {saving ? "Saving…" : "Save columns"}
        </Button>
        <Button type="button" variant="outline" onClick={() => setList(products.map((p) => p.id))}>
          All, by company
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
