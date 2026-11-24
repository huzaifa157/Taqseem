"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";

import { FieldError, FormMessage } from "@/components/form/form-message";
import { useRequestId } from "@/components/form/use-request-id";
import { Combobox, rankText } from "@/components/sales/combobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { type ActionState, fieldError, idleState } from "@/lib/action-state";
import { formatMoney } from "@/lib/format";
import { formatDozens, PACKETS_PER_DOZEN, parseQuantity } from "@/lib/units";
import { cn } from "@/lib/utils";

type Product = {
  id: string;
  code: string;
  name: string;
  companyId: string;
  /** Null for roles that may not see cost. */
  purchaseRate: string | null;
};
type Line = { productId: string; qty: string; rate: string };

const LABEL = "text-muted-foreground text-[11px] font-semibold tracking-wider uppercase";
const METHODS = [
  { value: "CASH", label: "Cash" },
  { value: "CHEQUE", label: "Cheque" },
  { value: "ONLINE", label: "Online" },
];
const money = (v: string) => {
  const n = Number(v.trim().replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * A purchase in one step: the company, the products that came in (type a code or name → Enter →
 * dozens → Enter → rate → Enter, back to the search for the next one) and what was paid now
 * (blank or 0: all on the company's account; "Full" fills in the total). Saving adds the stock,
 * creates the company bill and records the payment. Ctrl+Enter saves.
 */
export function PurchaseEntry({
  action,
  companies,
  products,
  today,
  showRate,
  canPay,
  notice,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  companies: { id: string; name: string }[];
  products: Product[];
  today: string;
  showRate: boolean;
  canPay: boolean;
  notice?: React.ReactNode;
}) {
  const [state, formAction, saving] = useActionState(action, idleState);
  const withRequestId = useRequestId();
  const [companyId, setCompanyId] = useState(companies.length === 1 ? companies[0]!.id : "");
  const [lines, setLines] = useState<Line[]>([]);
  const [paid, setPaid] = useState("");
  const [method, setMethod] = useState("CASH");
  const search = useRef<HTMLInputElement>(null);
  const focusAfter = useRef<string | null>(null);

  const companyProducts = products.filter((p) => p.companyId === companyId);
  const byId = new Map(products.map((p) => [p.id, p]));
  const packets = (l: Line) => parseQuantity(l.qty) ?? 0;
  const amount = (l: Line) => (packets(l) / PACKETS_PER_DOZEN) * money(l.rate);
  const total = lines.reduce((s, l) => s + amount(l), 0);
  const totalPackets = lines.reduce((s, l) => s + packets(l), 0);
  const paidNow = money(paid);

  // A new line's dozens box gets focus once it has rendered.
  useEffect(() => {
    if (!focusAfter.current) return;
    const el = document.getElementById(`qty-${focusAfter.current}`);
    if (el instanceof HTMLInputElement) el.select();
    focusAfter.current = null;
  }, [lines]);

  const add = (p: Product) => {
    focusAfter.current = p.id;
    setLines((ls) =>
      ls.some((l) => l.productId === p.id)
        ? [...ls]
        : [...ls, { productId: p.id, qty: "", rate: p.purchaseRate ?? "" }],
    );
  };
  const update = (productId: string, change: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.productId === productId ? { ...l, ...change } : l)));
  const remove = (productId: string) => {
    setLines((ls) => ls.filter((l) => l.productId !== productId));
    search.current?.focus();
  };

  return (
    <form
      action={(fd) => formAction(withRequestId(fd))}
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          e.currentTarget.requestSubmit();
        } else if (e.key === "Enter" && t instanceof HTMLInputElement && t.type !== "radio") {
          if (t.getAttribute("role") === "combobox") return; // the search picks on Enter
          e.preventDefault();
          // In a line: dozens → rate → back to the search.
          const id = t.id.replace(/^(qty|rate)-/, "");
          if (t.id.startsWith("qty-") && showRate)
            (document.getElementById(`rate-${id}`) as HTMLInputElement | null)?.select();
          else if (t.id.startsWith("qty-") || t.id.startsWith("rate-")) search.current?.focus();
        }
      }}
      className="max-w-6xl space-y-4"
    >
      {notice}
      <div className="bg-card grid gap-3 rounded-xl border p-4 sm:grid-cols-[2fr_1fr_1fr_1fr]">
        <div className="space-y-1">
          <Label htmlFor="companyId" className={LABEL}>
            Company
          </Label>
          <NativeSelect
            id="companyId"
            name="companyId"
            value={companyId}
            autoFocus={!companyId}
            onChange={(e) => {
              setCompanyId(e.target.value);
              setLines([]);
              setTimeout(() => search.current?.focus(), 0);
            }}
            aria-invalid={fieldError(state, "companyId") ? true : undefined}
          >
            <option value="">Choose the company…</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
          <FieldError id="companyId-error" message={fieldError(state, "companyId")} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="receivedDate" className={LABEL}>
            Date
          </Label>
          <Input id="receivedDate" name="receivedDate" type="date" defaultValue={today} required />
        </div>
        <div className="space-y-1">
          <Label htmlFor="supplierRef" className={LABEL}>
            Company invoice no.
          </Label>
          <Input id="supplierRef" name="supplierRef" maxLength={60} autoComplete="off" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="sacksReceived" className={LABEL}>
            Sacks
          </Label>
          <Input
            id="sacksReceived"
            name="sacksReceived"
            inputMode="numeric"
            placeholder="0"
            title="Empty sacks go back to the company for a credit"
          />
        </div>
      </div>

      <section className="bg-card overflow-hidden rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left">
            <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:font-semibold">
              <th className="w-10">#</th>
              <th>Item</th>
              <th className="w-32 text-right">Dozens</th>
              {showRate ? <th className="w-36 text-right">Rate / dz</th> : null}
              {showRate ? <th className="w-36 text-right">Amount</th> : null}
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const p = byId.get(l.productId)!;
              const qtyError = fieldError(state, `quantity.${l.productId}`);
              return (
                <tr key={l.productId} className="border-t">
                  <td className="text-muted-foreground px-3 py-1">{i + 1}</td>
                  <td className="px-3 py-1">
                    {p.name}{" "}
                    <span className="text-muted-foreground font-mono text-xs">{p.code}</span>
                    <input type="hidden" name="productId" value={l.productId} />
                  </td>
                  <td className="px-3 py-1">
                    <Input
                      id={`qty-${l.productId}`}
                      name="quantity"
                      inputMode="decimal"
                      autoComplete="off"
                      aria-label={`Dozens of ${p.name}`}
                      value={l.qty}
                      onChange={(e) => update(l.productId, { qty: e.target.value })}
                      className="h-8 text-right tabular-nums"
                      aria-invalid={qtyError ? true : undefined}
                    />
                    <FieldError id={`qty-${l.productId}-error`} message={qtyError} />
                    {showRate ? null : <input type="hidden" name="rate" value="" />}
                  </td>
                  {showRate ? (
                    <td className="px-3 py-1">
                      <Input
                        id={`rate-${l.productId}`}
                        name="rate"
                        inputMode="decimal"
                        autoComplete="off"
                        aria-label={`Rate of ${p.name}`}
                        value={l.rate}
                        onChange={(e) => update(l.productId, { rate: e.target.value })}
                        className="h-8 text-right tabular-nums"
                      />
                    </td>
                  ) : null}
                  {showRate ? (
                    <td className="px-3 py-1 text-right font-semibold tabular-nums">
                      {amount(l) ? formatMoney(amount(l).toFixed(2)) : ""}
                    </td>
                  ) : null}
                  <td className="px-2 py-1 text-center">
                    <button
                      type="button"
                      onClick={() => remove(l.productId)}
                      className="text-destructive hover:bg-destructive/10 rounded px-1.5 font-semibold"
                      title={`Remove ${p.name}`}
                      aria-label={`Remove ${p.name}`}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
            <tr className="bg-brand/5 border-t">
              <td className="px-3 py-1.5 font-semibold">{lines.length + 1}</td>
              <td className="px-3 py-1.5" colSpan={showRate ? 4 : 2}>
                {companyId ? (
                  <Combobox
                    label="Add product"
                    hideLabel
                    floating
                    tabPicks
                    inputRef={search}
                    autoFocus={Boolean(companyId)}
                    inputClassName="h-8 bg-background"
                    items={companyProducts}
                    getKey={(p) => p.id}
                    rank={(p, q) => rankText(q, p.code, p.name)}
                    render={(p) => (
                      <span className="flex justify-between gap-3">
                        <span>
                          {p.name} <span className="font-mono text-xs">{p.code}</span>
                        </span>
                        {p.purchaseRate ? (
                          <span className="text-muted-foreground tabular-nums">
                            {formatMoney(p.purchaseRate)}
                          </span>
                        ) : null}
                      </span>
                    )}
                    onSelect={add}
                    placeholder="Item code or name, then Enter"
                    emptyText="No product of this company matches"
                  />
                ) : (
                  <span className="text-muted-foreground">Choose the company first.</span>
                )}
              </td>
              <td />
            </tr>
          </tbody>
        </table>
        <div className="bg-muted/40 flex flex-wrap items-center justify-between gap-3 border-t px-4 py-2">
          <span className="text-muted-foreground text-sm">
            {lines.length} {lines.length === 1 ? "item" : "items"}
          </span>
          <p className="flex items-baseline gap-3">
            <span className={LABEL}>Total qty</span>
            <span className="text-2xl font-bold tabular-nums">{formatDozens(totalPackets)}</span>
            {showRate ? (
              <>
                <span aria-hidden className="bg-border mx-2 h-6 w-px self-center" />
                <span className={LABEL}>Bill total</span>
                <span className="text-2xl font-bold tabular-nums">
                  {formatMoney(total.toFixed(2))}
                </span>
              </>
            ) : null}
          </p>
        </div>
      </section>

      {canPay && showRate ? (
        <fieldset className="bg-card flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border p-4">
          <legend className="sr-only">Paid now</legend>
          <label htmlFor="paidAmount" className={LABEL}>
            Paid now
          </label>
          <div className="bg-background focus-within:border-ring focus-within:ring-ring/40 flex h-10 items-center gap-1 rounded-md border pr-1 pl-3 focus-within:ring-2">
            <span className="text-muted-foreground text-sm">Rs</span>
            <input
              id="paidAmount"
              name="paidAmount"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              className="w-28 bg-transparent text-lg font-semibold tabular-nums outline-none"
              value={paid}
              onChange={(e) => setPaid(e.target.value)}
              aria-invalid={fieldError(state, "paidAmount") ? true : undefined}
            />
            <button
              type="button"
              className="text-muted-foreground hover:bg-muted rounded px-2 py-1 text-xs font-semibold"
              title="Paid the whole bill"
              onClick={() => setPaid(total ? total.toFixed(2) : "")}
            >
              Full
            </button>
          </div>
          <div
            role="radiogroup"
            aria-label="How"
            className="bg-muted flex h-10 items-center rounded-md p-1"
          >
            {METHODS.map((m) => (
              <label
                key={m.value}
                className="has-[:checked]:bg-background cursor-pointer rounded px-2.5 py-1.5 text-sm has-[:checked]:font-medium has-[:checked]:shadow-xs"
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
              <Input
                name="chequeNo"
                placeholder="Cheque no."
                className="h-10 w-28"
                maxLength={30}
              />
              <Input name="bankName" placeholder="Bank" className="h-10 w-32" maxLength={60} />
              <Input name="chequeDate" type="date" defaultValue={today} className="h-10 w-40" />
            </>
          ) : method === "ONLINE" ? (
            <Input name="reference" placeholder="Reference" className="h-10 w-52" maxLength={80} />
          ) : null}
          <div className="ml-auto text-right" aria-live="polite">
            <p className={LABEL}>{paidNow > total ? "Advance with the company" : "Still owed"}</p>
            <p className={cn("text-xl font-bold tabular-nums")}>
              {formatMoney(Math.abs(total - paidNow).toFixed(2))}
            </p>
          </div>
          <FieldError id="paidAmount-error" message={fieldError(state, "paidAmount")} />
          {["chequeNo", "bankName", "chequeDate"].map((f) => (
            <FieldError key={f} id={`${f}-error`} message={fieldError(state, f)} />
          ))}
        </fieldset>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          name="note"
          placeholder="Note (optional)"
          maxLength={500}
          className="h-10 max-w-md"
        />
        <FormMessage state={state} />
        <div className="ml-auto flex gap-2">
          <Button asChild variant="ghost" className="h-10">
            <Link href="/purchases/receipts">Cancel</Link>
          </Button>
          <Button
            type="submit"
            name="intent"
            value="next"
            variant="outline"
            className="h-10"
            disabled={saving || lines.length === 0}
          >
            Save &amp; next
          </Button>
          <Button
            type="submit"
            disabled={saving || lines.length === 0}
            className="bg-brand text-brand-foreground hover:bg-brand/90 h-10 px-4"
          >
            {saving ? "Saving…" : "Save purchase"}
          </Button>
        </div>
      </div>
    </form>
  );
}
