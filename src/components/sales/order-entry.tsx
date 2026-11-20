"use client";

import Link from "next/link";
import {
  useActionState,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";

import { FieldError, FormMessage } from "@/components/form/form-message";
import { useRequestId } from "@/components/form/use-request-id";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { type ActionState, fieldError, idleState } from "@/lib/action-state";
import { formatMoney } from "@/lib/format";
import { localPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";
import {
  billTotals,
  checkCredit,
  type PricedLine,
  priceLineFor,
  readCustomerDiscount,
} from "@/lib/sales";
import { formatDozens, PACKETS_PER_HALF_DOZEN, parseQuantity, quantityText } from "@/lib/units";
import { orderEntryContextAction } from "@/server/sales-actions";
import type { OrderEntryContext } from "@/server/services/sales/orders";

import { Combobox, rankText } from "./combobox";

type CustomerOption = {
  id: string;
  name: string;
  shopName: string | null;
  phone: string | null;
  area: { name: string } | null;
};
/**
 * `discount`: the customer's own discount per dozen on this product (blank = the product's
 * discount and slabs). Starts at their saved discount; saved for them when the order is saved.
 */
type Line = { productId: string; qty: string; discount?: string };
type Product = OrderEntryContext["products"][number];

const SOURCES = [
  { value: "OFFICE", label: "Office (booker call)" },
  { value: "WHATSAPP", label: "WhatsApp" },
  { value: "BOOKER_APP", label: "Booker app" },
];

const WAREHOUSE_KEY = "taqseem.orderWarehouse";

/** Dozens a new line starts with (the smallest amount that can be sold). */
const DEFAULT_QTY = "0.5";

/**
 * Whether what was typed in the customer box is exactly this customer: the same name (any capitals
 * or spacing, names are unique) or the same phone. Otherwise "+ New customer" is offered too.
 */
function isSameCustomer(c: CustomerOption, typed: string) {
  const name = (t: string) => t.trim().replace(/s+/g, " ").toLowerCase();
  if (name(c.name) === name(typed)) return true;
  const digits = typed.replace(/D/g, "");
  return (
    digits.length >= 7 &&
    [c.phone, localPhone(c.phone)].some((p) => p && p.replace(/D/g, "") === digits)
  );
}

/** The warehouse remembered on this computer (browser only; null on the server). */
function readSavedWarehouse(): string | null {
  try {
    return localStorage.getItem(WAREHOUSE_KEY);
  } catch {
    return null;
  }
}

/** Re-read when another tab changes it. */
function subscribeSavedWarehouse(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/** "3.5" or "3dz 6pk" → 42 packets; null unless a positive number of whole or half dozens. */
function halfDozens(qty: string): number | null {
  const packets = parseQuantity(qty);
  return packets && packets % PACKETS_PER_HALF_DOZEN === 0 ? packets : null;
}

/**
 * Keyboard-first order entry:
 *  1. type the customer (name, shop, phone or area) → Enter;
 *  2. type a product code or name → Enter → type dozens → Enter, or Tab Tab (past the discount),
 *     back to the product box in the grid's entry row, under the last line. Enter in the
 *     header (dates, note, new customer) moves to the next box, and from the last one into
 *     the grid;
 *  3. Ctrl+Enter books the order. In a dozens box: Alt+R the customer's discount, Ctrl+Delete
 *     removes the line. Rates are fixed; a discount typed on a line is saved for the customer.
 * Prices, discounts, available stock and the credit limit update as you type; the server
 * recalculates everything when saving.
 */
export function OrderEntry({
  action,
  customers,
  warehouses,
  canOverrideCredit,
  initial,
  mode = "order",
  areas = [],
  header,
  notice,
}: {
  /** The page's top bar: back link, title and a short note (the form adds its own boxes). */
  header: { backHref: string; backLabel: string; title: string; description?: string };
  /** A "saved" notice from the last save, shown under the top bar. */
  notice?: React.ReactNode;
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  customers: CustomerOption[];
  warehouses: { id: string; name: string }[];
  canOverrideCredit: boolean;
  initial: {
    orderId?: string;
    customerId?: string;
    warehouseId?: string;
    orderDate: string;
    deliveryDate: string;
    source?: string;
    note?: string;
    lines?: Line[];
  };
  /** "counter": a sale collected at the warehouse, posted when saved, with payment taken now. */
  mode?: "order" | "counter";
  /** For a new customer typed on the order: their area decides the warehouse. */
  areas?: { id: string; name: string; warehouseId: string; warehouseName: string }[];
}) {
  const counter = mode === "counter";
  const isNew = !initial.orderId;
  const [state, formAction, saving] = useActionState(action, idleState);
  const withRequestId = useRequestId();
  const [customerId, setCustomerId] = useState(initial.customerId ?? "");
  // The warehouse for a customer without an area (or a new one): the one chosen here, else the one
  // last chosen on this computer, else, on the counter, the first warehouse, so a counter sale
  // never asks. useSyncExternalStore reads the saved one after hydration (no mismatch).
  const savedWarehouseId = useSyncExternalStore(
    subscribeSavedWarehouse,
    readSavedWarehouse,
    () => null,
  );
  const [chosenWarehouseId, setChosenWarehouseId] = useState(initial.warehouseId ?? "");
  const warehouseId =
    chosenWarehouseId ||
    (warehouses.some((w) => w.id === savedWarehouseId) ? savedWarehouseId! : "") ||
    // The counter, or a business with one warehouse, never has to choose.
    (counter || warehouses.length === 1 ? (warehouses[0]?.id ?? "") : "");
  const setWarehouseId = (id: string) => {
    setChosenWarehouseId(id);
    try {
      if (id) localStorage.setItem(WAREHOUSE_KEY, id);
    } catch {
      // Storage blocked (private window): the choice just is not remembered.
    }
  };
  const [context, setContext] = useState<OrderEntryContext | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const [lines, setLines] = useState<Line[]>(initial.lines ?? []);
  const [allowOver, setAllowOver] = useState(false);
  // A customer not in the list yet: created with the order from name and phone.
  const [newCustomer, setNewCustomer] = useState<{
    name: string;
    phone: string;
    areaId: string;
  } | null>(null);
  const newArea = areas.find((a) => a.id === newCustomer?.areaId);
  // A new counter customer without an area is served from the chosen warehouse.
  const newWarehouseId = newArea?.warehouseId ?? (counter ? warehouseId || warehouses[0]?.id : "");
  const [paid, setPaid] = useState("");
  // Most counter customers pay the whole bill: ticked by default, untick to enter an amount.
  const [paidFull, setPaidFull] = useState(counter);
  const [method, setMethod] = useState("CASH");
  const productSearch = useRef<HTMLInputElement>(null);
  const customerSearch = useRef<HTMLInputElement>(null);
  const [noteOpen, setNoteOpen] = useState(Boolean(initial.note));
  // "Change" (F2): the customer search comes back; the customer stays until another is picked.
  const [changingCustomer, setChangingCustomer] = useState(false);
  useEffect(() => {
    if (changingCustomer) customerSearch.current?.focus();
  }, [changingCustomer]);
  useEffect(() => {
    if (!isNew) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F2") return;
      e.preventDefault();
      setChangingCustomer(true);
      customerSearch.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isNew]);
  const gridScrollRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  // Keep the bill grid fitted to the window (see fitGridToWindow).
  useEffect(() => {
    const fit = () => fitGridToWindow(gridScrollRef.current, sectionRef.current, footerRef.current);
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  });
  const qtyInputs = useRef(new Map<string, HTMLInputElement>());
  // After picking a customer, the product search appears once their products have loaded.
  const focusSearchWhenLoaded = useRef(false);
  useEffect(() => {
    if (context && focusSearchWhenLoaded.current) {
      focusSearchWhenLoaded.current = false;
      focusEntryBox(productSearch.current);
    }
  }, [context]);

  // Product whose quantity box should get focus once its new line has rendered.
  const pendingFocus = useRef<string | null>(null);

  // Load the customer panel and product list whenever the customer (or warehouse) changes.
  const isNewCustomer = newCustomer !== null;
  useEffect(() => {
    if (!customerId && !(isNewCustomer && newWarehouseId)) return;
    startLoading(async () => {
      const result = await orderEntryContextAction(customerId, {
        warehouseId: (customerId ? warehouseId : newWarehouseId) || undefined,
        excludeOrderId: initial.orderId,
      });
      if ("error" in result) {
        setContextError(result.error);
        setContext(null);
      } else {
        setContextError(null);
        setContext(result);
      }
    });
  }, [customerId, warehouseId, initial.orderId, isNewCustomer, newWarehouseId]);

  useEffect(() => {
    if (pendingFocus.current) {
      qtyInputs.current.get(pendingFocus.current)?.select();
      pendingFocus.current = null;
    }
  }, [lines]);

  const products = context?.products ?? [];
  const productById = new Map(products.map((p) => [p.id, p]));
  const priced: (PricedLine & { product: Product })[] = [];
  for (const line of lines) {
    const product = productById.get(line.productId);
    const qty = halfDozens(line.qty);
    if (product && qty)
      priced.push({
        ...priceLineFor(
          product,
          qty,
          readCustomerDiscount(line.discount, product.saleRate).discount,
        ),
        product,
      });
  }
  const { total, byCompany } = billTotals(priced);
  const paidNow = paidFull
    ? Number(total.netAmount.toString())
    : /^\d+(\.\d{1,2})?$/.test(paid.trim())
      ? Number(paid)
      : 0;
  // What a counter sale leaves on the customer's account.
  const onAccount = Math.max(Number(total.netAmount.toString()) - paidNow, 0);
  const credit = context
    ? checkCredit({
        creditLimit: context.customer.creditLimit,
        pending: context.pending,
        openOrders: context.openOrders,
        thisOrder: counter ? onAccount : total.netAmount,
      })
    : null;

  const chooseCustomer = (c: CustomerOption) => {
    focusSearchWhenLoaded.current = true;
    setChangingCustomer(false);
    setNewCustomer(null);
    setCustomerId(c.id);
    setLines([]);
    setAllowOver(false);
  };

  const addProduct = (p: Product) => {
    if (lines.some((l) => l.productId === p.id)) {
      // Already on the order: jump to its quantity.
      qtyInputs.current.get(p.id)?.select();
      return;
    }
    pendingFocus.current = p.id;
    // The customer's own discount on this product is used again (it can still be changed).
    // Starts at half a dozen, selected: Enter keeps it, typing a number replaces it.
    setLines((ls) => [
      ...ls,
      { productId: p.id, qty: DEFAULT_QTY, discount: p.customerDiscount ?? "" },
    ]);
  };

  const repeatLastOrder = () => {
    if (!context?.lastOrder) return;
    setLines(
      context.lastOrder.lines
        .filter((l) => productById.has(l.productId))
        .map((l) => ({
          productId: l.productId,
          qty: quantityText(l.quantity),
          discount: productById.get(l.productId)?.customerDiscount ?? "",
        })),
    );
  };

  // Nothing matched what was typed: start a new customer with it as the phone or the name.
  const startNewCustomer = (typed: string) => {
    const isPhone = /^[+\d][\d\s-]*$/.test(typed);
    setChangingCustomer(false);
    setCustomerId("");
    setContext(null);
    setLines([]);
    setAllowOver(false);
    setNewCustomer({ name: isPhone ? "" : typed, phone: isPhone ? typed : "", areaId: "" });
  };

  const customer = customers.find((c) => c.id === customerId);
  // An existing customer without an area: the goods come from the warehouse chosen in "From"
  // (on the counter it is always filled in), sent with the order.
  const customerWithoutArea = Boolean(
    context && !newCustomer && context.customer.areaName === null,
  );
  const needsWarehouse = Boolean(context && !context.warehouseId && !newCustomer);

  const hasProducts = Boolean(context && context.warehouseId);
  const cannotSave = saving || !context || lines.length === 0;
  // The grid always shows GRID_ROWS rows (lines, the entry row, then empty ones) like a ledger.
  const emptyRows = Math.max(0, GRID_ROWS - lines.length - 1);

  // Enter in the header goes to the next header box, and from the last one into the grid.
  const nextHeaderField = (from: HTMLElement) => {
    const header = from.closest("[data-voucher-header]");
    const fields = header
      ? [
          ...header.querySelectorAll<HTMLElement>(
            "input:not([type=hidden]):not([disabled]), select:not([disabled])",
          ),
        ]
      : [];
    const next = fields[fields.indexOf(from) + 1];
    if (next) next.focus();
    else focusEntryBox(productSearch.current);
  };

  // The warehouse the goods come from: fixed by the customer's (or new customer's) area, otherwise
  // chosen here (remembered on this computer).
  const fixedWarehouseId = newCustomer
    ? newArea?.warehouseId
    : context && !customerWithoutArea
      ? (context.warehouseId ?? undefined)
      : undefined;
  const fixedWarehouseName = warehouses.find((w) => w.id === fixedWarehouseId)?.name;
  const showSearch = isNew && ((!customerId && !newCustomer) || changingCustomer);

  return (
    <form
      action={(fd) => formAction(isNew ? withRequestId(fd) : fd)}
      onKeyDown={(e) => {
        const target = e.target as HTMLElement;
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          e.currentTarget.requestSubmit();
        } else if (e.altKey && !e.ctrlKey && e.code === "KeyL") {
          // Alt+L: repeat the customer's last order (its products and dozens).
          e.preventDefault();
          repeatLastOrder();
        } else if (
          e.key === "Enter" &&
          ((target instanceof HTMLInputElement &&
            target.type !== "checkbox" &&
            target.type !== "radio") ||
            target instanceof HTMLSelectElement)
        ) {
          // Plain Enter never submits by accident. In a line it goes back to the product box;
          // in the header to the next box (the customer box handles its own Enter).
          e.preventDefault();
          if (target.name === "quantity" || target.name === "discount")
            focusEntryBox(productSearch.current);
          else if (target.getAttribute("role") !== "combobox") nextHeaderField(target);
        } else if (target instanceof HTMLInputElement && target.name === "quantity") {
          const productId = target.id.replace(/^qty-/, "");
          if (e.key === "Delete" && e.ctrlKey) {
            e.preventDefault();
            setLines((ls) => ls.filter((l) => l.productId !== productId));
            focusEntryBox(productSearch.current);
          } else if (e.altKey && e.code === "KeyR") {
            e.preventDefault();
            document.getElementById(`discount-${productId}`)?.focus();
          }
        }
      }}
      className="space-y-3"
    >
      <input type="hidden" name="customerId" value={customerId} />
      {newCustomer && !newArea ? (
        <input type="hidden" name="warehouseId" value={newWarehouseId ?? ""} />
      ) : null}
      {customerWithoutArea || needsWarehouse || initial.warehouseId ? (
        <input type="hidden" name="warehouseId" value={warehouseId} />
      ) : null}
      <input type="hidden" name="allowOverCredit" value={allowOver ? "true" : "false"} />

      <div data-voucher-header className="space-y-3">
        {/* Top bar. Counter sale: title, note, warehouse, date. Orders: back link, title, short
            explanation, warehouse, repeat last order and the dates. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Link
            href={header.backHref}
            data-back-link
            aria-keyshortcuts="Escape"
            className={cn(
              "text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm",
              // Not shown on the counter sale; Esc still goes back through it.
              counter && "sr-only",
            )}
          >
            ← {header.backLabel}
            <Kbd>Esc</Kbd>
          </Link>
          {counter ? null : <span aria-hidden className="bg-border h-5 w-px" />}
          <h1 className="text-lg font-semibold tracking-tight">{header.title}</h1>
          {counter ? (
            <div className="bg-background focus-within:border-ring focus-within:ring-ring/40 flex h-9 min-w-48 flex-1 items-center gap-2 rounded-md border px-2.5 focus-within:ring-2">
              <label htmlFor="note" className={HEADER_LABEL}>
                Note
              </label>
              <Input
                id="note"
                name="note"
                className={cn(PILL_INPUT, "w-full")}
                defaultValue={initial.note}
                maxLength={500}
                placeholder="Optional"
              />
            </div>
          ) : header.description ? (
            <p
              className="text-muted-foreground min-w-0 flex-1 basis-48 truncate text-xs"
              title={header.description}
            >
              {header.description}
            </p>
          ) : (
            <span className="flex-1" />
          )}
          {/* No "From" on the counter sale (it sells from the customer's area warehouse, else the
              remembered or first one), nor when there is only one warehouse. */}
          {!counter && warehouses.length > 1 ? (
            <Pill label="From" htmlFor="order-warehouse">
              {fixedWarehouseId ? (
                <span className="text-sm font-medium" title="Set by the customer's area">
                  {fixedWarehouseName}
                </span>
              ) : newCustomer && !counter ? (
                <span className="text-muted-foreground text-sm">Set by the area</span>
              ) : (
                <NativeSelect
                  id="order-warehouse"
                  className={PILL_INPUT}
                  value={newCustomer ? (newWarehouseId ?? "") : warehouseId}
                  onChange={(e) => setWarehouseId(e.target.value)}
                  title="Where the goods come from (remembered on this computer)"
                >
                  {!newCustomer ? <option value="">Choose a warehouse</option> : null}
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Pill>
          ) : null}
          <Button
            type="button"
            variant="outline"
            className="h-9"
            onClick={repeatLastOrder}
            disabled={!hasProducts || !context?.lastOrder}
            aria-keyshortcuts="Alt+L"
            title={
              context?.lastOrder
                ? `Repeat order #${context.lastOrder.number}`
                : "The customer has no earlier order"
            }
          >
            ↻ Repeat last order <Kbd>Alt+L</Kbd>
          </Button>
          {counter ? (
            <Pill label="Date" htmlFor="saleDate">
              <Input
                id="saleDate"
                name="saleDate"
                type="date"
                className={PILL_INPUT}
                defaultValue={initial.orderDate}
                required
              />
            </Pill>
          ) : (
            <>
              <Pill label="Order" htmlFor="orderDate">
                <Input
                  id="orderDate"
                  name="orderDate"
                  type="date"
                  className={PILL_INPUT}
                  defaultValue={initial.orderDate}
                  required
                />
              </Pill>
              <Pill label="Delivery" htmlFor="deliveryDate">
                <Input
                  id="deliveryDate"
                  name="deliveryDate"
                  type="date"
                  className={PILL_INPUT}
                  defaultValue={initial.deliveryDate}
                  required
                  aria-invalid={fieldError(state, "deliveryDate") ? true : undefined}
                />
              </Pill>
              <Pill label="Via" htmlFor="source">
                <NativeSelect
                  id="source"
                  name="source"
                  className={PILL_INPUT}
                  defaultValue={initial.source ?? "OFFICE"}
                >
                  {SOURCES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </NativeSelect>
              </Pill>
            </>
          )}
        </div>
        <FieldError id="deliveryDate-error" message={fieldError(state, "deliveryDate")} />
        {notice}

        {/* Customer card: who, and what they owe after this order. */}
        <div className="bg-card rounded-xl border shadow-xs">
          <div className="grid items-center gap-x-6 gap-y-2 px-4 py-2.5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            <div className="min-w-0">
              {showSearch ? (
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <Combobox
                      label="Customer"
                      labelClassName={HEADER_LABEL}
                      inputClassName="h-10 text-base"
                      inputRef={customerSearch}
                      items={customers}
                      getKey={(c) => c.id}
                      rank={(c, q) =>
                        rankText(
                          q,
                          null,
                          c.name,
                          c.shopName,
                          c.phone,
                          localPhone(c.phone),
                          c.area?.name,
                        )
                      }
                      render={(c) => (
                        <span>
                          <span className="font-medium">{c.name}</span>
                          {c.shopName ? ` · ${c.shopName}` : ""}
                          <span className="text-muted-foreground">
                            {c.area ? ` · ${c.area.name}` : ""}
                            {c.phone ? ` · ${c.phone}` : ""}
                          </span>
                        </span>
                      )}
                      onSelect={chooseCustomer}
                      onNoMatch={startNewCustomer}
                      noMatchLabel={(q) => `+ New customer “${q}”`}
                      isExact={isSameCustomer}
                      placeholder="Name, shop, phone or area — a new name adds a customer"
                      autoFocus={!customerId}
                    />
                  </div>
                  {changingCustomer && customer ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className="mt-5 h-10"
                      onClick={() => setChangingCustomer(false)}
                    >
                      Keep {customer.name}
                    </Button>
                  ) : null}
                </div>
              ) : newCustomer ? (
                <NewCustomerFields
                  state={state}
                  value={newCustomer}
                  onChange={(v) => setNewCustomer({ ...newCustomer, ...v })}
                  onCancel={() => {
                    setNewCustomer(null);
                    setContext(null);
                    setLines([]);
                  }}
                  areas={areas}
                  counter={counter}
                />
              ) : (
                <CustomerIdentity
                  name={context?.customer.name ?? customer?.name ?? ""}
                  details={
                    context
                      ? [context.customer.shopName, context.customer.areaName]
                          .filter(Boolean)
                          .join(" · ") || "No area"
                      : (customer?.shopName ?? "")
                  }
                  flag={
                    context?.customer.isFlagged
                      ? `Flagged${context.customer.flagReason ? `: ${context.customer.flagReason}` : ""}`
                      : null
                  }
                  onChange={isNew ? () => setChangingCustomer(true) : undefined}
                />
              )}
              {/* Orders: the note sits under the customer, closed until needed (the counter sale
                  has it in the top bar). */}
              <div className="mt-2">
                {counter ? null : noteOpen ? (
                  <div className="flex min-w-0 items-center gap-2">
                    <Label htmlFor="note" className={HEADER_LABEL}>
                      Note
                    </Label>
                    <Input
                      id="note"
                      name="note"
                      className="h-8 md:text-sm"
                      defaultValue={initial.note}
                      maxLength={500}
                      autoFocus={!initial.note}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground text-sm"
                    onClick={() => setNoteOpen(true)}
                  >
                    + Add a note
                  </button>
                )}
              </div>
            </div>
            <div>
              <BalancePanel
                context={newCustomer ? null : context}
                isNewCustomer={Boolean(newCustomer)}
                loading={loading}
                error={contextError}
                credit={credit}
                counter={counter}
                extra={
                  context && !newCustomer ? (
                    <CompanyBalances context={context} byCompany={byCompany} />
                  ) : null
                }
              />
            </div>
          </div>
        </div>
      </div>

      {/* The bill: a numbered grid, the main thing on the screen. */}
      <section ref={sectionRef} aria-labelledby="lines-heading" className="space-y-1.5">
        <h2 id="lines-heading" className="sr-only">
          {counter ? "Sale" : "Order"} lines
        </h2>
        <div className="bg-card overflow-hidden rounded-xl border shadow-xs">
          {/* Its height is fitted to the window (fitGridToWindow), so lines never push the page. */}
          <div ref={gridScrollRef} className="h-[22rem] overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/60 sticky top-0 z-10 backdrop-blur">
                <tr>
                  <GridTh className="w-10">#</GridTh>
                  <GridTh className="w-full">Item</GridTh>
                  <GridTh className="text-right">In stock</GridTh>
                  <GridTh className="text-right">Qty</GridTh>
                  <GridTh>Unit</GridTh>
                  <GridTh className="text-right">Price</GridTh>
                  <GridTh className="text-right">Disc / dz</GridTh>
                  <GridTh className="text-right">Amount</GridTh>
                  <GridTh className="w-8">
                    <span className="sr-only">Remove</span>
                  </GridTh>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, i) => {
                  const product = productById.get(line.productId);
                  if (!product) return null;
                  const qty = halfDozens(line.qty);
                  const p = priced.find((x) => x.productId === line.productId);
                  const short = qty !== null && qty > product.available;
                  const error =
                    fieldError(state, `lines.${i}.quantity`) ??
                    (line.qty && qty === null
                      ? "Whole or half dozens: 2, 2.5 or 2dz 6pk"
                      : undefined);
                  return (
                    <tr key={line.productId} className="hover:bg-muted/30 group">
                      <GridTd className="text-muted-foreground tabular-nums">{i + 1}</GridTd>
                      {/* One line: a long name is cut, the full name shows on hover. */}
                      <GridTd className="max-w-0 truncate">
                        <label
                          htmlFor={`qty-${product.id}`}
                          className="font-medium"
                          title={`${product.name} · ${product.code} · ${product.companyName}`}
                        >
                          {product.name}
                        </label>
                        <span className="text-muted-foreground ml-2 font-mono text-xs">
                          {product.code}
                        </span>
                        <span className="text-muted-foreground text-xs">
                          {" "}
                          · {product.companyName}
                        </span>
                        <input type="hidden" name="productId" value={product.id} />
                      </GridTd>
                      <GridTd className="text-right whitespace-nowrap">
                        {short ? (
                          <Badge variant="destructive">
                            Short {formatDozens(qty! - product.available)}
                          </Badge>
                        ) : (
                          <StockPill packets={product.available} />
                        )}
                      </GridTd>
                      <GridTd className="text-right">
                        <Input
                          id={`qty-${product.id}`}
                          name="quantity"
                          inputMode="decimal"
                          autoComplete="off"
                          className={cn(GRID_INPUT, "ml-auto w-20 font-semibold")}
                          ref={(el) => {
                            if (el) qtyInputs.current.set(product.id, el);
                            else qtyInputs.current.delete(product.id);
                          }}
                          value={line.qty}
                          onChange={(e) =>
                            setLines((ls) =>
                              ls.map((l) =>
                                l.productId === line.productId ? { ...l, qty: e.target.value } : l,
                              ),
                            )
                          }
                          aria-invalid={error ? true : undefined}
                          aria-describedby={error ? `qty-${product.id}-error` : undefined}
                        />
                        <FieldError id={`qty-${product.id}-error`} message={error} />
                      </GridTd>
                      <GridTd className="text-muted-foreground">Dozen</GridTd>
                      <GridTd className="text-right tabular-nums">
                        {formatMoney(product.saleRate)}
                      </GridTd>
                      <GridTd className="text-right">
                        <DiscountCell
                          line={line}
                          product={product}
                          priced={p}
                          error={fieldError(state, `lines.${i}.discount`)}
                          onChange={(discount) =>
                            setLines((ls) =>
                              ls.map((l) =>
                                l.productId === line.productId ? { ...l, discount } : l,
                              ),
                            )
                          }
                        />
                      </GridTd>
                      <GridTd className="text-right font-semibold tabular-nums">
                        {p ? formatMoney(p.netAmount) : "—"}
                      </GridTd>
                      <GridTd className="px-1">
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-destructive rounded px-1.5 py-0.5"
                          aria-label={`Remove ${product.name}`}
                          aria-keyshortcuts="Control+Delete"
                          title="Remove (Ctrl+Delete in the dozens box)"
                          tabIndex={-1}
                          onClick={() =>
                            setLines((ls) => ls.filter((l) => l.productId !== line.productId))
                          }
                        >
                          ×
                        </button>
                      </GridTd>
                    </tr>
                  );
                })}
                {/* The entry row: type the next item here; it becomes a line on Enter. */}
                <tr className="bg-brand/5">
                  <GridTd className="border-l-brand border-l-2 font-semibold tabular-nums">
                    {lines.length + 1}
                  </GridTd>
                  <GridTd colSpan={2}>
                    {hasProducts ? (
                      <Combobox
                        label="Add product"
                        hideLabel
                        floating
                        inputClassName="h-7 border-brand/50 bg-background focus-visible:border-brand focus-visible:ring-brand/20"
                        items={products}
                        getKey={(p) => p.id}
                        rank={(p, q) => rankText(q, p.code, p.name, p.companyName)}
                        render={(p) => (
                          <span className="flex justify-between gap-3">
                            <span>
                              {p.name} <span className="font-mono text-xs">{p.code}</span>
                              <span className="text-muted-foreground"> · {p.companyName}</span>
                            </span>
                            <span
                              className={
                                p.available <= 0
                                  ? "text-destructive font-medium"
                                  : "text-muted-foreground"
                              }
                            >
                              {formatDozens(p.available)} free
                            </span>
                          </span>
                        )}
                        onSelect={addProduct}
                        inputRef={productSearch}
                        placeholder="Item code or name, then Enter"
                      />
                    ) : (
                      <p className="text-muted-foreground flex h-7 items-center text-sm">
                        {loading
                          ? "Loading…"
                          : needsWarehouse
                            ? "Choose the warehouse first (From, at the top)."
                            : "Choose the customer first."}
                      </p>
                    )}
                  </GridTd>
                  {Array.from({ length: GRID_COLUMNS - 4 }, (_, j) => (
                    <GridTd key={j} />
                  ))}
                  <GridTd className="text-muted-foreground text-right">—</GridTd>
                </tr>
                {Array.from({ length: emptyRows }, (_, k) => (
                  <tr
                    key={`empty-${k}`}
                    aria-hidden
                    className="h-[33px]"
                    onClick={() => focusEntryBox(productSearch.current)}
                  >
                    <GridTd className="text-muted-foreground/50 tabular-nums">
                      {lines.length + 2 + k}
                    </GridTd>
                    {Array.from({ length: GRID_COLUMNS - 1 }, (_, j) => (
                      <GridTd key={j} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="bg-muted/40 flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t px-4 py-1.5">
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-sm">
              <span>
                {lines.length} {lines.length === 1 ? "item" : "items"}
              </span>
              {total.discountAmount.gt(0) ? (
                <>
                  <span aria-hidden>·</span>
                  <span>
                    Discount given{" "}
                    <span className="text-foreground font-semibold tabular-nums">
                      {formatMoney(total.discountAmount)}
                    </span>
                  </span>
                </>
              ) : null}
              <span aria-hidden className="pointer-coarse:hidden">
                ·
              </span>
              <span className="text-xs pointer-coarse:hidden">
                <ShortcutHelp counter={counter} />
              </span>
            </div>
            <p className="flex items-baseline gap-3">
              {/* Total quantity next to the bill total, as large, so both are read together. */}
              <span className={HEADER_LABEL}>Total qty</span>
              <span className="text-2xl font-bold tracking-tight tabular-nums">
                {formatDozens(total.quantity)}
              </span>
              <span aria-hidden className="bg-border mx-2 h-6 w-px self-center" />
              <span className={HEADER_LABEL}>BILL TOTAL</span>
              <span className="text-2xl font-bold tracking-tight tabular-nums">
                {formatMoney(total.netAmount)}
              </span>
            </p>
          </div>
        </div>
      </section>

      {/* Pinned to the bottom of the window: payment, warnings and the save buttons. */}
      <div
        ref={footerRef}
        className="bg-background/95 sticky bottom-0 z-20 -mx-3 space-y-2 border-t px-3 py-2 backdrop-blur sm:-mx-6 sm:px-6"
      >
        {credit?.over ? (
          <div
            role="alert"
            className="border-destructive bg-destructive/5 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border px-3 py-2 text-sm"
          >
            <p className="font-medium">
              This {counter ? "sale" : "order"} takes the customer {formatMoney(credit.over)} past
              their credit limit of {formatMoney(credit.limit)}.
            </p>
            {canOverrideCredit ? (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={allowOver}
                  onChange={(e) => setAllowOver(e.target.checked)}
                />
                Allow past the credit limit
              </label>
            ) : counter ? (
              <p>Take more payment now, or ask the owner to allow it.</p>
            ) : (
              <p>
                You can still book it; it will wait for the owner&apos;s approval before dispatch.
              </p>
            )}
          </div>
        ) : null}

        <FormMessage state={state} />

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {counter && hasProducts ? (
            <PaidNow
              state={state}
              paid={paid}
              setPaid={setPaid}
              paidFull={paidFull}
              setPaidFull={setPaidFull}
              method={method}
              setMethod={setMethod}
              total={total.netAmount.toString()}
              onAccount={onAccount}
            />
          ) : null}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button asChild variant="ghost" className="h-10 px-3">
              <Link href={initial.orderId ? `/orders/${initial.orderId}` : "/orders"}>Cancel</Link>
            </Button>
            {isNew ? (
              <Button
                type="submit"
                name="intent"
                value="next"
                variant="outline"
                className="h-10"
                disabled={cannotSave}
                title={
                  counter ? "Save, then enter the next sale" : "Book, then enter the next order"
                }
              >
                {counter ? "Save & next" : "Book & next"}
              </Button>
            ) : null}
            {counter ? (
              <Button
                type="submit"
                name="intent"
                value="print"
                variant="outline"
                className="h-10"
                disabled={cannotSave}
                title="Save and print the bill"
              >
                Save &amp; print
              </Button>
            ) : null}
            <Button
              type="submit"
              disabled={cannotSave}
              className="bg-brand text-brand-foreground hover:bg-brand/90 h-10 px-4"
            >
              {saving ? "Saving…" : counter ? "Save sale" : isNew ? "Book order" : "Save changes"}
              {/* The amount too on wide screens; on a laptop the bar stays one line. */}
              {!saving && lines.length > 0 ? (
                <span className="hidden tabular-nums 2xl:inline">
                  · {formatMoney(total.netAmount)}
                </span>
              ) : null}
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}

/**
 * Focuses the entry row's box and scrolls the grid only as far as needed: the entry row stays at
 * the bottom edge, so as many lines as possible stay in view (plain focus() may centre it).
 */
function focusEntryBox(el: HTMLInputElement | null) {
  if (!el) return;
  el.focus({ preventScroll: true });
  el.closest("tr")?.scrollIntoView({ block: "nearest" });
}

/**
 * Fits the bill grid's scroll area to the window: from where the grid starts down to the pinned
 * bar, less what sits under the grid (totals, hints). So the header, the whole grid, the total and
 * the bar always fit, whatever the header holds (a new customer, a warning) and however many
 * lines there are; extra lines scroll inside the grid. Run after every render and on resize.
 */
function fitGridToWindow(
  grid: HTMLElement | null,
  section: HTMLElement | null,
  footer: HTMLElement | null,
) {
  if (!grid || !section) return;
  // Phones and narrow windows scroll the page as usual.
  if (window.innerWidth < 768) {
    grid.style.height = "";
    return;
  }
  const box = grid.getBoundingClientRect();
  const top = box.top + window.scrollY;
  const under = section.getBoundingClientRect().bottom - box.bottom;
  // 12px gap above the bar and the page's 24px bottom padding.
  const room = window.innerHeight - top - under - (footer?.offsetHeight ?? 0) - 36;
  // A fixed height (not just a maximum): the grid always fills the free space, like Busy.
  grid.style.height = `${Math.max(MIN_GRID_HEIGHT, Math.floor(room))}px`;
}

/** The grid always shows at least five rows (header + 5 × 33 px); below that the page scrolls. */
const MIN_GRID_HEIGHT = 200;

/**
 * Empty numbered rows after the lines, so the grid reads as a ledger and fills its space like a
 * voucher screen; the grid's height is fixed to the window, so rows past it just scroll.
 */
const GRID_ROWS = 25;
/** Columns of the bill grid: #, item, in stock, qty, unit, price, discount, amount, remove. */
const GRID_COLUMNS = 9;
/** Stock under this (10 dozen) shows amber. */
const LOW_STOCK_PACKETS = 120;

const HEADER_LABEL = "text-muted-foreground text-[11px] font-semibold tracking-wider uppercase";
const HEADER_INPUT = "h-9 bg-background md:text-sm";
/** An input inside a Pill: no border of its own, the pill draws it. */
const PILL_INPUT =
  "h-8 w-auto border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 md:text-sm";
/** Qty and discount boxes in the grid: read like text, a border on hover and focus. */
const GRID_INPUT =
  "h-7 border-transparent bg-transparent text-right tabular-nums shadow-none hover:border-input focus-visible:bg-background";

/** A labelled box in the top bar: "FROM Shahdara Warehouse", "DATE 20/11/2026". */
function Pill({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-background focus-within:border-ring focus-within:ring-ring/40 flex h-9 items-center gap-2 rounded-md border px-2.5 focus-within:ring-2">
      <label htmlFor={htmlFor} className={HEADER_LABEL}>
        {label}
      </label>
      {children}
    </div>
  );
}

/** Stock free to sell, as a small pill: amber when low, red when none. */
function StockPill({ packets }: { packets: number }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
        packets <= 0
          ? "bg-destructive/15 text-destructive"
          : packets < LOW_STOCK_PACKETS
            ? "bg-warning/25 text-foreground"
            : "bg-muted text-foreground",
      )}
    >
      {formatDozens(packets)}
    </span>
  );
}

/** The keyboard shortcuts of the order screen. */
function ShortcutHelp({ counter }: { counter: boolean }) {
  const keys: [string, string][] = [
    ["Enter", "add the item, then type dozens (3.5)"],
    ["Enter / Tab Tab", "next item"],
    ["Alt+R", "customer's discount on the line"],
    ["Ctrl+Delete", "remove the line"],
    ["Alt+L", "repeat last order"],
    ["F2", "change the customer"],
    ["Ctrl+Enter", counter ? "save the sale" : "book the order"],
    ["Esc", "leave the box"],
  ];
  return (
    <details className="relative">
      <summary className="text-brand cursor-pointer font-medium underline underline-offset-2 select-none">
        All shortcuts
      </summary>
      <dl className="bg-popover text-popover-foreground absolute bottom-full left-0 z-30 mb-2 grid w-max grid-cols-[auto_auto] gap-x-3 gap-y-1 rounded-md border p-3 text-xs shadow-md">
        {keys.map(([key, what]) => (
          <div key={key} className="contents">
            <dt>
              <Kbd>{key}</Kbd>
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function GridTh({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={cn(
        "text-muted-foreground border-b px-3 py-2 text-left text-[11px] font-semibold tracking-wider whitespace-nowrap uppercase",
        className,
      )}
    >
      {children}
    </th>
  );
}

function GridTd({
  children,
  className,
  colSpan,
}: {
  children?: React.ReactNode;
  className?: string;
  colSpan?: number;
}) {
  return (
    <td colSpan={colSpan} className={cn("border-b px-3 py-0.5 align-middle", className)}>
      {children}
    </td>
  );
}

/** The product's own discount as a hint: "4", "5%" or "—". */
function normalDiscount(product: Product) {
  if (product.discountType === "NONE" || Number(product.discountValue) === 0) return "—";
  return product.discountType === "PERCENT"
    ? `${Number(product.discountValue)}%`
    : String(Number(product.discountValue));
}

/**
 * Discount / dz of one line: the customer's own discount on the product (rates are fixed). It
 * starts at their saved discount; blank uses the product's discount and slabs (the placeholder).
 * A change to the saved discount is noted under it.
 */
function DiscountCell({
  line,
  product,
  priced,
  error,
  onChange,
}: {
  line: Line;
  product: Product;
  priced?: PricedLine;
  error?: string;
  onChange: (discount: string) => void;
}) {
  const id = `discount-${product.id}`;
  const typed = readCustomerDiscount(line.discount, product.saleRate);
  const saved = product.customerDiscount;
  const message = error ?? typed.error;
  // Only a change to the saved discount gets a note, so most lines stay one row tall.
  let note: React.ReactNode = null;
  if (typed.discount && saved !== null && typed.discount.eq(saved)) note = null;
  else if (typed.discount && saved !== null)
    note = <span>Saved {formatMoney(saved)} → changes</span>;
  else if (typed.discount) note = <span>New for this customer: saved</span>;
  else if (saved !== null)
    note = (
      <button
        type="button"
        className="underline underline-offset-2"
        onClick={() => onChange(saved)}
        title="Use the customer's saved discount"
        tabIndex={-1}
      >
        Removes saved {formatMoney(saved)}
      </button>
    );
  const amount =
    priced && priced.discountAmount.gt(0) ? `−${formatMoney(priced.discountAmount)}` : null;
  return (
    <div className="ml-auto w-24">
      <label htmlFor={id} className="sr-only">
        Discount per dozen for {product.name}
      </label>
      <Input
        id={id}
        name="discount"
        inputMode="decimal"
        autoComplete="off"
        className={GRID_INPUT}
        placeholder={normalDiscount(product)}
        title={`${amount ? `Discount on this line: ${amount}. ` : ""}This customer's discount per dozen. Blank: the product's discount and slabs.`}
        aria-keyshortcuts="Alt+R"
        value={line.discount ?? ""}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={message ? true : undefined}
        aria-describedby={message ? `${id}-error` : undefined}
      />
      <FieldError id={`${id}-error`} message={message} />
      {note ? (
        <p className="text-muted-foreground mt-0.5 text-right text-[11px] leading-tight">{note}</p>
      ) : null}
    </div>
  );
}

/** Two letters for the customer's round badge: "Nadeem Mughal" → "NM". */
function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (
    (words[0]?.[0] ?? "") + (words.length > 1 ? (words.at(-1)?.[0] ?? "") : "")
  ).toUpperCase();
}

/** The chosen customer: badge, name, shop and area, and "Change (F2)" on a new order. */
function CustomerIdentity({
  name,
  details,
  flag,
  onChange,
}: {
  name: string;
  details: string;
  flag: string | null;
  onChange?: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden
        className="bg-brand/10 text-brand grid size-11 shrink-0 place-items-center rounded-full text-base font-bold"
      >
        {initials(name)}
      </span>
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-lg leading-tight font-semibold">
          {name}
          {flag ? <Badge variant="destructive">{flag}</Badge> : null}
        </p>
        <p className="text-muted-foreground truncate text-sm">{details}</p>
      </div>
      {onChange ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-2"
          onClick={onChange}
          aria-keyshortcuts="F2"
        >
          Change <Kbd>F2</Kbd>
        </Button>
      ) : null}
    </div>
  );
}

/**
 * What the customer owes after this order, with how much of the credit limit that uses (green,
 * amber past 80%, red past the limit), and the figures it is made of.
 */
function BalancePanel({
  context,
  isNewCustomer,
  loading,
  error,
  credit,
  counter,
  extra,
}: {
  /** Shown at the end of the figures line (the "Balances by company" toggle). */
  extra?: React.ReactNode;
  context: OrderEntryContext | null;
  isNewCustomer: boolean;
  loading: boolean;
  error: string | null;
  credit: ReturnType<typeof checkCredit> | null;
  counter: boolean;
}) {
  const shell = "lg:border-l lg:pl-6";
  if (error)
    return (
      <p role="alert" className={cn(shell, "text-destructive text-sm")}>
        {error}
      </p>
    );
  if (isNewCustomer)
    return (
      <div className={cn(shell, "text-sm")}>
        <p className={HEADER_LABEL}>Balance after this order</p>
        <p className="text-muted-foreground mt-1">
          A new customer: no balance yet and no credit limit.
        </p>
      </div>
    );
  if (!context)
    return (
      <div className={cn(shell, "text-muted-foreground text-sm")}>
        {loading ? "Loading the customer…" : "Pick a customer to see what they owe."}
      </div>
    );
  const limit = context.customer.creditLimit === null ? null : Number(context.customer.creditLimit);
  const after = Number(credit?.exposure ?? context.pending);
  const used = limit && limit > 0 ? Math.min(100, (after / limit) * 100) : 0;
  const tone = credit?.over ? "bg-destructive" : used > 80 ? "bg-warning" : "bg-brand";
  return (
    <section aria-label="Customer balance" aria-busy={loading} className={cn(shell, "space-y-1")}>
      {/* One line: label, the balance, what is left; the credit limit at the right. */}
      <div className="flex flex-wrap items-baseline gap-x-3">
        <p className={HEADER_LABEL}>Balance after</p>
        <span
          className={cn(
            "text-2xl leading-tight font-bold tracking-tight tabular-nums",
            credit?.over && "text-destructive",
          )}
        >
          {formatMoney(after)}
        </span>
        {limit !== null ? (
          <span
            className={cn("text-xs", credit?.over ? "text-destructive" : "text-muted-foreground")}
          >
            {credit?.over
              ? `${formatMoney(credit.over)} over the limit`
              : `${formatMoney(Math.max(limit - after, 0))} still available`}
          </span>
        ) : null}
        <span className="text-muted-foreground ml-auto text-xs">
          {limit === null ? "No credit limit" : `Limit ${formatMoney(limit)}`}
        </span>
      </div>
      {limit !== null ? (
        <div
          className="bg-muted h-1.5 overflow-hidden rounded-full"
          role="meter"
          aria-label="Credit limit used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(used)}
        >
          <div className={cn("h-full rounded-full", tone)} style={{ width: `${used}%` }} />
        </div>
      ) : null}
      <dl className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
        <div className="flex gap-1.5">
          <dt>Pending now</dt>
          <dd className="text-foreground font-semibold tabular-nums">
            {formatMoney(context.pending)}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt>Other open orders</dt>
          <dd className="text-foreground font-semibold tabular-nums">
            {formatMoney(context.openOrders)}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt>This order{counter ? " (on account)" : ""}</dt>
          <dd className="text-foreground font-semibold tabular-nums">
            {formatMoney(credit?.thisOrder ?? "0")}
          </dd>
        </div>
        {extra ? <div className="ml-auto">{extra}</div> : null}
      </dl>
    </section>
  );
}

/** "Balances by company": what is pending per company, and this order's split when it has several. */
function CompanyBalances({
  context,
  byCompany,
}: {
  context: OrderEntryContext;
  byCompany: Map<string, { netAmount: { toString(): string } }>;
}) {
  const thisOrder = [...byCompany];
  if (context.pendingByCompany.length === 0 && thisOrder.length < 2) return null;
  return (
    <details className="group relative text-xs">
      <summary className="text-muted-foreground hover:text-foreground w-fit cursor-pointer list-none select-none">
        Balances by company <span className="inline-block group-open:rotate-180">▾</span>
      </summary>
      <dl className="bg-popover text-popover-foreground absolute top-full right-0 z-30 mt-1 grid w-max max-w-xl gap-x-6 gap-y-1 rounded-md border p-3 shadow-md sm:grid-cols-2">
        {context.pendingByCompany.map((p) => (
          <div key={p.companyId} className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Pending · {p.companyName}</dt>
            <dd className="font-medium tabular-nums">{formatMoney(p.amount)}</dd>
          </div>
        ))}
        {thisOrder.length > 1
          ? thisOrder.map(([companyId, t]) => (
              <div key={companyId} className="flex justify-between gap-3">
                <dt className="text-muted-foreground">
                  This order ·{" "}
                  {context.products.find((p) => p.companyId === companyId)?.companyName}
                </dt>
                <dd className="font-medium tabular-nums">{formatMoney(t.netAmount)}</dd>
              </div>
            ))
          : null}
      </dl>
    </details>
  );
}

/**
 * A customer created with this order: name, phone (optional) and area, in the customer card. The
 * warehouse (for a counter customer without an area) is the "From" box at the top.
 */
function NewCustomerFields({
  state,
  value,
  onChange,
  onCancel,
  areas,
  counter,
}: {
  state: ActionState;
  value: { name: string; phone: string; areaId: string };
  onChange: (v: Partial<{ name: string; phone: string; areaId: string }>) => void;
  onCancel: () => void;
  areas: { id: string; name: string; warehouseName: string }[];
  counter: boolean;
}) {
  const err = (name: string) => fieldError(state, name);
  // The warehouse after each area only helps when areas are in more than one.
  const manyWarehouses = new Set(areas.map((a) => a.warehouseName)).size > 1;
  return (
    <div role="group" aria-labelledby="new-customer-title" className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p
          id="new-customer-title"
          className="flex items-center gap-2 text-sm font-semibold"
          title={`Saved as a retailer with this ${counter ? "sale" : "order"}. If a customer already has this name or phone, it goes to them instead.`}
        >
          <span className="bg-brand/10 text-brand rounded px-1.5 py-0.5 text-[11px] tracking-wider uppercase">
            New
          </span>
          New customer
        </p>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
      <div className="grid grid-cols-6 items-start gap-x-3 gap-y-2">
        <div className={cn("col-span-6 space-y-1", "sm:col-span-2")}>
          <Label htmlFor="new-customer-name" className={HEADER_LABEL}>
            Name
          </Label>
          <Input
            id="new-customer-name"
            name="newCustomerName"
            maxLength={120}
            className={HEADER_INPUT}
            autoFocus={!value.name}
            value={value.name}
            onChange={(e) => onChange({ name: e.target.value })}
            aria-invalid={err("newCustomerName") ? true : undefined}
          />
          <FieldError id="new-customer-name-error" message={err("newCustomerName")} />
        </div>
        <div className="col-span-3 space-y-1 sm:col-span-2">
          <Label htmlFor="new-customer-phone" className={HEADER_LABEL}>
            Phone
          </Label>
          <Input
            id="new-customer-phone"
            name="newCustomerPhone"
            type="tel"
            inputMode="tel"
            className={HEADER_INPUT}
            placeholder="Optional"
            title="Optional; saved as +92"
            autoFocus={Boolean(value.name) && !value.phone}
            value={value.phone}
            onChange={(e) => onChange({ phone: e.target.value })}
            aria-invalid={err("newCustomerPhone") ? true : undefined}
          />
          <FieldError id="new-customer-phone-error" message={err("newCustomerPhone")} />
        </div>
        {/* Optional on the counter (a walk-in needs none); a delivery needs it for the route. */}
        <div className="col-span-3 space-y-1 sm:col-span-2">
          <Label htmlFor="new-customer-area" className={HEADER_LABEL}>
            Area {counter ? <span className="font-normal opacity-75">· optional</span> : null}
          </Label>
          <NativeSelect
            id="new-customer-area"
            name="newCustomerAreaId"
            className={HEADER_INPUT}
            value={value.areaId}
            onChange={(e) => onChange({ areaId: e.target.value })}
          >
            <option value="">{counter ? "No area" : "Choose the area"}</option>
            {areas.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {manyWarehouses ? ` · ${a.warehouseName}` : ""}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
    </div>
  );
}

const METHODS = [
  { value: "CASH", label: "Cash" },
  { value: "CHEQUE", label: "Cheque" },
  { value: "ONLINE", label: "Online" },
];

/**
 * Counter sale: what the customer pays now (Full = the whole bill), how, and what goes on their
 * account. In the pinned bar beside the save buttons.
 */
function PaidNow({
  state,
  paid,
  setPaid,
  paidFull,
  setPaidFull,
  method,
  setMethod,
  total,
  onAccount,
}: {
  state: ActionState;
  paid: string;
  setPaid: (v: string) => void;
  paidFull: boolean;
  setPaidFull: (v: boolean) => void;
  method: string;
  setMethod: (v: string) => void;
  total: string;
  onAccount: number;
}) {
  const extra = (
    name: string,
    label: string,
    width: string,
    props: React.ComponentProps<typeof Input> = {},
  ) => (
    <div className={width}>
      <Label htmlFor={`counter-${name}`} className="sr-only">
        {label}
      </Label>
      <Input
        id={`counter-${name}`}
        name={name}
        className="h-10 md:text-sm"
        placeholder={label}
        title={label}
        aria-invalid={fieldError(state, name) ? true : undefined}
        {...props}
      />
      <FieldError id={`counter-${name}-error`} message={fieldError(state, name)} />
    </div>
  );
  return (
    <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <legend className="sr-only">Paid now</legend>
      <div className="flex items-center gap-3">
        <label htmlFor="counter-paidAmount" className={HEADER_LABEL}>
          Paid now
        </label>
        <div className="bg-background focus-within:border-ring focus-within:ring-ring/40 flex h-10 items-center gap-1 rounded-md border pr-1 pl-3 focus-within:ring-2">
          <span className="text-muted-foreground text-sm">Rs</span>
          <input
            id="counter-paidAmount"
            name="paidAmount"
            inputMode="decimal"
            autoComplete="off"
            className="w-20 bg-transparent text-lg font-semibold tabular-nums outline-none"
            value={paidFull ? total : paid}
            readOnly={paidFull}
            placeholder="0"
            onChange={(e) => setPaid(e.target.value)}
            aria-invalid={fieldError(state, "paidAmount") ? true : undefined}
          />
          <button
            type="button"
            aria-pressed={paidFull}
            title="The customer pays the whole bill now"
            className={cn(
              "rounded px-2 py-1 text-xs font-semibold",
              paidFull ? "bg-brand/15 text-brand" : "text-muted-foreground hover:bg-muted",
            )}
            onClick={() => {
              setPaidFull(!paidFull);
              if (paidFull) setPaid("");
            }}
          >
            Full
          </button>
        </div>
        <FieldError id="counter-paidAmount-error" message={fieldError(state, "paidAmount")} />
      </div>
      <div
        role="radiogroup"
        aria-label="How"
        className="bg-muted flex h-10 items-center rounded-md p-1"
      >
        {METHODS.map((m) => (
          <label
            key={m.value}
            className="has-[:checked]:bg-background has-[:focus-visible]:ring-ring/50 cursor-pointer rounded px-2.5 py-1.5 text-sm has-[:checked]:font-medium has-[:checked]:shadow-xs has-[:focus-visible]:ring-2"
          >
            <input
              type="radio"
              name="method"
              value={m.value}
              className="sr-only"
              checked={method === m.value}
              onChange={() => setMethod(m.value)}
            />
            {m.label}
          </label>
        ))}
      </div>
      {method === "CHEQUE" ? (
        <>
          {extra("chequeNo", "Cheque no.", "w-28", { maxLength: 30 })}
          {extra("bankName", "Bank", "w-32", { maxLength: 60 })}
          {extra("chequeDate", "Cheque date", "w-36", { type: "date" })}
        </>
      ) : method === "ONLINE" ? (
        extra("reference", "Reference (bank, Easypaisa …)", "w-52", { maxLength: 80 })
      ) : null}
      <div aria-live="polite">
        <p className={HEADER_LABEL}>Goes on account</p>
        <p className="text-xl leading-tight font-bold tabular-nums">{formatMoney(onAccount)}</p>
      </div>
    </fieldset>
  );
}
