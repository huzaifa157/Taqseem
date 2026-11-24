"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";

import { FieldError, FormMessage } from "@/components/form/form-message";
import { useRequestId } from "@/components/form/use-request-id";
import { Combobox, rankText } from "@/components/sales/combobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type ActionState, fieldError, idleState } from "@/lib/action-state";
import { formatMoney } from "@/lib/format";
import { localPhone } from "@/lib/phone";
import { priceLineFor } from "@/lib/sales";
import { formatDozens, PACKETS_PER_DOZEN, parseQuantity } from "@/lib/units";
import { cn } from "@/lib/utils";
import { orderEntryContextAction } from "@/server/sales-actions";
import type { OrderEntryContext } from "@/server/services/sales/orders";

type Customer = {
  id: string;
  name: string;
  shopName: string | null;
  phone: string | null;
  area: { name: string; warehouseId: string } | null;
};
type Product = OrderEntryContext["products"][number];
type Line = { productId: string; qty: string; rate: string };
type Kind = "damaged" | "replacement";

const LABEL = "text-muted-foreground text-[11px] font-semibold tracking-wider uppercase";
const money = (v: string) => {
  const n = Number(v.trim().replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/** What this customer pays per dozen at this quantity (sale rate less their discount or slabs). */
function paidRate(p: Product, packets: number): string {
  if (packets <= 0) return "";
  const priced = priceLineFor(
    {
      id: p.id,
      companyId: p.companyId,
      saleRate: p.saleRate,
      discountType: p.discountType,
      discountValue: p.discountValue,
      tiers: p.tiers,
    },
    packets,
    p.customerDiscount,
  );
  return ((Number(priced.netAmount.toString()) * PACKETS_PER_DOZEN) / packets).toFixed(2);
}

/**
 * Customer damage: the customer, the damaged goods they brought back, and anything given in
 * exchange. The account changes by damaged value − exchange value (credit, or charge when the
 * exchange is worth more). Values start at what the customer pays and can be changed. Keyboard:
 * item → Enter → quantity (dozens, or "6pk") → Enter → rate → Enter → back to the item box.
 */
export function DamageEntry({
  action,
  customers,
  defaultWarehouseId,
  today,
  notice,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  customers: Customer[];
  /** For a customer with no area. */
  defaultWarehouseId: string;
  today: string;
  notice?: React.ReactNode;
}) {
  const [state, formAction, saving] = useActionState(action, idleState);
  const withRequestId = useRequestId();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [context, setContext] = useState<OrderEntryContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const [damaged, setDamaged] = useState<Line[]>([]);
  const [replacements, setReplacements] = useState<Line[]>([]);
  // Rates the user typed (otherwise the rate follows the quantity: what the customer pays).
  const [typedRate, setTypedRate] = useState<Record<string, boolean>>({});
  const search = {
    damaged: useRef<HTMLInputElement>(null),
    replacement: useRef<HTMLInputElement>(null),
  };
  const focusAfter = useRef<string | null>(null);

  useEffect(() => {
    if (!customer) return;
    startLoading(async () => {
      const r = await orderEntryContextAction(customer.id, {
        warehouseId: customer.area ? undefined : defaultWarehouseId,
      });
      if ("error" in r) {
        setLoadError(r.error);
        setContext(null);
      } else {
        setLoadError(null);
        setContext(r);
        setTimeout(() => search.damaged.current?.focus(), 0);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only for a new customer
  }, [customer, defaultWarehouseId]);

  useEffect(() => {
    if (!focusAfter.current) return;
    const el = document.getElementById(focusAfter.current);
    if (el instanceof HTMLInputElement) el.select();
    focusAfter.current = null;
  }, [damaged, replacements]);

  const products = context?.products ?? [];
  const byId = new Map(products.map((p) => [p.id, p]));
  const setOf = (kind: Kind) => (kind === "damaged" ? setDamaged : setReplacements);
  const packets = (l: Line) => parseQuantity(l.qty) ?? 0;
  const rateOf = (kind: Kind, l: Line) =>
    typedRate[`${kind}-${l.productId}`] ? l.rate : paidRate(byId.get(l.productId)!, packets(l));
  const amount = (kind: Kind, l: Line) => (packets(l) / PACKETS_PER_DOZEN) * money(rateOf(kind, l));
  const total = (kind: Kind, ls: Line[]) => ls.reduce((s, l) => s + amount(kind, l), 0);
  const damagedValue = total("damaged", damaged);
  const replacementValue = total("replacement", replacements);
  const net = damagedValue - replacementValue;

  const add = (kind: Kind) => (p: Product) => {
    focusAfter.current = `${kind}-qty-${p.id}`;
    setOf(kind)((ls) =>
      ls.some((l) => l.productId === p.id)
        ? [...ls]
        : [...ls, { productId: p.id, qty: "", rate: "" }],
    );
  };
  const update = (kind: Kind, productId: string, change: Partial<Line>) =>
    setOf(kind)((ls) => ls.map((l) => (l.productId === productId ? { ...l, ...change } : l)));

  const grid = (kind: Kind, ls: Line[], title: string, hint: string) => (
    <section className="bg-card overflow-hidden rounded-xl border">
      <header className="flex items-baseline justify-between gap-3 border-b px-4 py-2">
        <h2 className="font-semibold">{title}</h2>
        <span className="text-muted-foreground text-xs">{hint}</span>
      </header>
      <table className="w-full text-sm">
        <thead className="bg-muted text-left">
          <tr className="[&>th]:px-3 [&>th]:py-1.5 [&>th]:font-semibold">
            <th className="w-8">#</th>
            <th>Item</th>
            {kind === "replacement" ? <th className="w-24 text-right">In stock</th> : null}
            <th className="w-28 text-right">Qty</th>
            <th className="w-32 text-right">Rate / dz</th>
            <th className="w-32 text-right">Value</th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {ls.map((l, i) => {
            const p = byId.get(l.productId);
            if (!p) return null;
            return (
              <tr key={l.productId} className="border-t">
                <td className="text-muted-foreground px-3 py-1">{i + 1}</td>
                <td className="px-3 py-1">
                  {p.name} <span className="text-muted-foreground font-mono text-xs">{p.code}</span>
                  <input type="hidden" name={`${kind}ProductId`} value={l.productId} />
                </td>
                {kind === "replacement" ? (
                  <td className="text-muted-foreground px-3 py-1 text-right tabular-nums">
                    {formatDozens(p.onHand)}
                  </td>
                ) : null}
                <td className="px-3 py-1">
                  <Input
                    id={`${kind}-qty-${l.productId}`}
                    name={`${kind}Quantity`}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="dz or 6pk"
                    aria-label={`Quantity of ${p.name}`}
                    value={l.qty}
                    onChange={(e) => update(kind, l.productId, { qty: e.target.value })}
                    className="h-8 text-right tabular-nums"
                  />
                </td>
                <td className="px-3 py-1">
                  <Input
                    id={`${kind}-rate-${l.productId}`}
                    name={`${kind}Rate`}
                    inputMode="decimal"
                    autoComplete="off"
                    aria-label={`Rate of ${p.name}`}
                    value={rateOf(kind, l)}
                    onChange={(e) => {
                      setTypedRate((t) => ({ ...t, [`${kind}-${l.productId}`]: true }));
                      update(kind, l.productId, { rate: e.target.value });
                    }}
                    className="h-8 text-right tabular-nums"
                    title="What the customer pays per dozen; change it if agreed otherwise"
                  />
                </td>
                <td className="px-3 py-1 text-right font-semibold tabular-nums">
                  {amount(kind, l) ? formatMoney(amount(kind, l).toFixed(2)) : ""}
                </td>
                <td className="px-2 py-1 text-center">
                  <button
                    type="button"
                    onClick={() => setOf(kind)((x) => x.filter((y) => y.productId !== l.productId))}
                    className="text-destructive hover:bg-destructive/10 rounded px-1.5 font-semibold"
                    aria-label={`Remove ${p.name}`}
                  >
                    ×
                  </button>
                </td>
              </tr>
            );
          })}
          <tr className="bg-brand/5 border-t">
            <td className="px-3 py-1.5 font-semibold">{ls.length + 1}</td>
            <td className="px-3 py-1.5" colSpan={kind === "replacement" ? 5 : 4}>
              <Combobox
                label={title}
                hideLabel
                floating
                tabPicks
                inputRef={search[kind]}
                inputClassName="h-8 bg-background"
                items={products}
                getKey={(p) => p.id}
                rank={(p, q) => rankText(q, p.code, p.name, p.companyName)}
                render={(p) => (
                  <span className="flex justify-between gap-3">
                    <span>
                      {p.name} <span className="font-mono text-xs">{p.code}</span>
                      <span className="text-muted-foreground"> · {p.companyName}</span>
                    </span>
                    {kind === "replacement" ? (
                      <span className="text-muted-foreground tabular-nums">
                        {formatDozens(p.onHand)}
                      </span>
                    ) : null}
                  </span>
                )}
                onSelect={add(kind)}
                placeholder="Item code or name, then Enter"
              />
            </td>
            <td />
          </tr>
        </tbody>
      </table>
      <p className="bg-muted/40 border-t px-4 py-1.5 text-right text-sm">
        {title}: <strong className="tabular-nums">{formatMoney(total(kind, ls).toFixed(2))}</strong>
      </p>
    </section>
  );

  return (
    <form
      action={(fd) => formAction(withRequestId(fd))}
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          e.currentTarget.requestSubmit();
        } else if (e.key === "Enter" && t instanceof HTMLInputElement) {
          if (t.getAttribute("role") === "combobox") return;
          e.preventDefault();
          const m = /^(damaged|replacement)-(qty|rate)-(.+)$/.exec(t.id);
          if (!m) return;
          const [, kind, field, id] = m;
          if (field === "qty")
            (document.getElementById(`${kind}-rate-${id}`) as HTMLInputElement | null)?.select();
          else search[kind as Kind].current?.focus();
        }
      }}
      className="max-w-6xl space-y-4"
    >
      {notice}
      <input type="hidden" name="customerId" value={customer?.id ?? ""} />
      <div className="bg-card grid gap-3 rounded-xl border p-4 sm:grid-cols-[2fr_1fr_2fr]">
        <div className="space-y-1">
          {customer ? (
            <>
              <p className={LABEL}>Customer</p>
              <p className="flex h-9 items-center gap-2">
                <span className="font-medium">{customer.name}</span>
                {customer.shopName ? (
                  <span className="text-muted-foreground text-sm">· {customer.shopName}</span>
                ) : null}
                {context ? (
                  <span className="text-muted-foreground text-sm">
                    · owes {formatMoney(context.pending)}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="text-brand text-xs underline underline-offset-2"
                  onClick={() => {
                    setCustomer(null);
                    setContext(null);
                    setDamaged([]);
                    setReplacements([]);
                  }}
                >
                  Change
                </button>
              </p>
            </>
          ) : (
            <Combobox
              label="Customer"
              labelClassName={LABEL}
              autoFocus
              items={customers}
              getKey={(c) => c.id}
              rank={(c, q) =>
                rankText(q, null, c.name, c.shopName, c.phone, localPhone(c.phone), c.area?.name)
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
              onSelect={setCustomer}
              placeholder="Name, shop, phone or area"
            />
          )}
          <FieldError
            id="customer-error"
            message={fieldError(state, "customerId") ?? loadError ?? undefined}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="returnDate" className={LABEL}>
            Date
          </label>
          <Input id="returnDate" name="returnDate" type="date" defaultValue={today} required />
        </div>
        <div className="space-y-1">
          <label htmlFor="note" className={LABEL}>
            Note
          </label>
          <Input id="note" name="note" maxLength={300} placeholder="Optional" autoComplete="off" />
        </div>
      </div>

      {loading ? <p className="text-muted-foreground text-sm">Loading…</p> : null}
      {context ? (
        <>
          {grid(
            "damaged",
            damaged,
            "Damaged items",
            "Go into damaged stock; the company is claimed",
          )}
          {grid(
            "replacement",
            replacements,
            "Given in exchange",
            "Optional: goods the customer takes instead (leave empty for a credit only)",
          )}
          <div className="bg-card flex flex-wrap items-center justify-end gap-x-8 gap-y-2 rounded-xl border p-4">
            <p className="text-sm">
              Damaged{" "}
              <strong className="tabular-nums">{formatMoney(damagedValue.toFixed(2))}</strong>
              {replacements.length ? (
                <>
                  {" "}
                  − given{" "}
                  <strong className="tabular-nums">
                    {formatMoney(replacementValue.toFixed(2))}
                  </strong>
                </>
              ) : null}
            </p>
            <div className="text-right" aria-live="polite">
              <p className={LABEL}>
                {net > 0.004
                  ? "Credit to their account"
                  : net < -0.004
                    ? "Added to their account"
                    : "Account"}
              </p>
              <p className={cn("text-2xl font-bold tabular-nums")}>
                {Math.abs(net) < 0.005 ? "No change" : formatMoney(Math.abs(net).toFixed(2))}
              </p>
            </div>
          </div>
        </>
      ) : null}

      <FormMessage state={state} />
      <div className="flex justify-end gap-2">
        <Button asChild variant="ghost" className="h-10">
          <Link href="/damage">Cancel</Link>
        </Button>
        <Button
          type="submit"
          name="intent"
          value="next"
          variant="outline"
          className="h-10"
          disabled={saving || damaged.length === 0}
        >
          Save &amp; next
        </Button>
        <Button
          type="submit"
          disabled={saving || damaged.length === 0}
          className="bg-brand text-brand-foreground hover:bg-brand/90 h-10 px-4"
        >
          {saving ? "Saving…" : "Save damage"}
        </Button>
      </div>
    </form>
  );
}
