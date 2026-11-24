"use client";

import Decimal from "decimal.js";
import Link from "next/link";
import { useActionState, useEffect, useState, useTransition } from "react";

import { SelectField, TextField } from "@/components/form/field";
import { FieldError, FormMessage } from "@/components/form/form-message";
import { useRequestId } from "@/components/form/use-request-id";
import { Combobox, rankText } from "@/components/sales/combobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type ActionState, fieldError, idleState } from "@/lib/action-state";
import { formatMoney } from "@/lib/format";
import { localPhone } from "@/lib/phone";
import { allocateOldestFirst } from "@/lib/payments";
import type { PaymentContext } from "@/server/services/payments/customer-payments";

type Customer = {
  id: string;
  name: string;
  shopName: string | null;
  phone: string | null;
  area: { name: string } | null;
};

const METHODS = [
  { value: "CASH", label: "Cash" },
  { value: "CHEQUE", label: "Cheque" },
  { value: "ONLINE", label: "Online transfer" },
];

const amountOf = (v: string) =>
  /^\d+(\.\d{1,2})?$/.test(v.trim().replace(/,/g, ""))
    ? new Decimal(v.trim().replace(/,/g, ""))
    : null;

/**
 * Payment received at the office. Pick the customer to see what they owe (one account) and their
 * open bills; the table previews exactly how the server applies the amount: old balance first,
 * then the oldest bills; anything left over is an advance.
 */
export function CustomerPaymentForm({
  action,
  loadContext,
  customers,
  initialCustomerId,
  today,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  loadContext: (customerId: string) => Promise<PaymentContext | { error: string }>;
  customers: Customer[];
  initialCustomerId?: string;
  today: string;
}) {
  const [state, formAction, pending] = useActionState(action, idleState);
  const withRequestId = useRequestId();
  const [customerId, setCustomerId] = useState(initialCustomerId ?? "");
  const [context, setContext] = useState<PaymentContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const [method, setMethod] = useState("CASH");
  const [amount, setAmount] = useState("");

  useEffect(() => {
    if (!customerId) return;
    startLoading(async () => {
      const result = await loadContext(customerId);
      if ("error" in result) {
        setLoadError(result.error);
        setContext(null);
      } else {
        setLoadError(null);
        setContext(result);
      }
    });
  }, [customerId, loadContext]);

  const value = amountOf(amount);
  const debt = context ? { unbilled: new Decimal(context.unbilled), bills: context.bills } : null;
  const preview = value && debt ? allocateOldestFirst(value, debt) : null;
  const applied = (billId: string) => preview?.allocations.find((a) => a.billId === billId)?.amount;

  return (
    <form action={(fd) => formAction(withRequestId(fd))} className="max-w-5xl space-y-6">
      <input type="hidden" name="customerId" value={customerId} />
      <div className="space-y-2">
        {context ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-lg font-medium">
              {context.customer.name}
              {context.customer.shopName ? (
                <span className="text-muted-foreground"> · {context.customer.shopName}</span>
              ) : null}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setCustomerId("");
                setContext(null);
              }}
            >
              Change customer
            </Button>
          </div>
        ) : (
          <Combobox
            label="Customer"
            items={customers}
            getKey={(c) => c.id}
            autoFocus
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
            onSelect={(c) => setCustomerId(c.id)}
            placeholder="Name, shop, phone or area"
          />
        )}
        <FieldError
          id="customer-error"
          message={fieldError(state, "customerId") ?? loadError ?? undefined}
        />
        {loading ? <p className="text-muted-foreground text-sm">Loading…</p> : null}
        {context?.customer.isFlagged ? (
          <p
            role="alert"
            className="border-destructive text-destructive rounded-md border px-3 py-2 text-sm"
          >
            Flagged: {context.customer.flagReason ?? "check with the owner"}
          </p>
        ) : null}
      </div>

      {context ? (
        <>
          <div className="text-sm">
            Owes now <strong className="tabular-nums">{formatMoney(context.pending)}</strong>
          </div>

          <div className="grid gap-4 sm:grid-cols-4">
            <div className="space-y-1.5">
              <label htmlFor="field-amount" className="text-sm font-medium">
                Amount (PKR) <span className="text-muted-foreground">*</span>
              </label>
              <Input
                id="field-amount"
                name="amount"
                inputMode="decimal"
                autoComplete="off"
                autoFocus
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-invalid={fieldError(state, "amount") ? true : undefined}
              />
              <FieldError id="field-amount-error" message={fieldError(state, "amount")} />
            </div>
            <TextField
              state={state}
              name="paymentDate"
              label="Payment date"
              type="date"
              required
              defaultValue={today}
            />
            <div
              onChange={(e) => {
                const t = e.target;
                if (t instanceof HTMLSelectElement) setMethod(t.value);
              }}
            >
              <SelectField
                state={state}
                name="method"
                label="Method"
                required
                options={METHODS}
                defaultValue="CASH"
              />
            </div>
            {method === "CHEQUE" ? (
              <>
                <TextField
                  state={state}
                  name="chequeNo"
                  label="Cheque no."
                  required
                  maxLength={30}
                />
                <TextField state={state} name="bankName" label="Bank" required maxLength={60} />
                <TextField
                  state={state}
                  name="chequeDate"
                  label="Cheque date"
                  type="date"
                  required
                  defaultValue={today}
                />
              </>
            ) : (
              <TextField
                state={state}
                name="reference"
                label={method === "ONLINE" ? "Transfer reference" : "Reference"}
                maxLength={80}
              />
            )}
            <TextField
              state={state}
              name="note"
              label="Note"
              maxLength={500}
              className="sm:col-span-4"
            />
          </div>

          <section aria-labelledby="apply-heading" className="space-y-3">
            <h2 id="apply-heading" className="font-medium">
              Applied to <span className="text-muted-foreground font-normal">(oldest first)</span>
            </h2>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="px-3 py-2 font-medium">Owed for</th>
                    <th className="px-3 py-2 text-right font-medium">Unpaid</th>
                    <th className="px-3 py-2 text-right font-medium">This payment</th>
                  </tr>
                </thead>
                <tbody>
                  {context.unbilled === "0.00" && context.bills.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="text-muted-foreground px-3 py-3 text-center">
                        Nothing owed. The payment is kept as an advance.
                      </td>
                    </tr>
                  ) : null}
                  {context.unbilled !== "0.00" ? (
                    <tr className="border-t">
                      <td className="px-3 py-1.5">Old / opening balance</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {formatMoney(context.unbilled)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {preview && preview.unbilled.gt(0)
                          ? formatMoney(preview.unbilled.toFixed(2))
                          : ""}
                      </td>
                    </tr>
                  ) : null}
                  {context.bills.map((b) => (
                    <tr key={b.billId} className="border-t">
                      <td className="px-3 py-1.5">
                        Bill #{b.number} · {b.billDate}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {formatMoney(b.outstanding)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {applied(b.billId) ? formatMoney(applied(b.billId)!.toFixed(2)) : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-sm" aria-live="polite">
              {preview ? (
                <>
                  Applied {formatMoney(new Decimal(value!).sub(preview.advance).toFixed(2))}
                  {preview.advance.gt(0) ? (
                    <>
                      {" "}
                      · advance <strong>{formatMoney(preview.advance.toFixed(2))}</strong> kept on
                      the customer&apos;s account
                    </>
                  ) : null}
                </>
              ) : null}
            </p>
          </section>

          <FormMessage state={state} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Posting…" : "Post payment"}
            </Button>
            <Button type="submit" name="intent" value="next" variant="secondary" disabled={pending}>
              Post and receive next
            </Button>
            <Button asChild variant="ghost">
              <Link href="/payments">Cancel</Link>
            </Button>
          </div>
        </>
      ) : null}
    </form>
  );
}
