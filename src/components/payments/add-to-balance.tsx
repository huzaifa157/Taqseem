"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { FieldError } from "@/components/form/form-message";
import { useRequestId } from "@/components/form/use-request-id";
import { Combobox, rankText } from "@/components/sales/combobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { type ActionState, fieldError, idleState } from "@/lib/action-state";
import { localPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";

type Customer = {
  id: string;
  name: string;
  shopName: string | null;
  phone: string | null;
  area: { name: string } | null;
};

const LABEL = "text-muted-foreground text-[11px] font-semibold tracking-wider uppercase";

/**
 * Ledgers: add an amount to any customer's balance. Search the customer (name, shop, phone or
 * area) → Enter → amount → note → Enter. After it is added the box is ready for the next one.
 */
export function AddToBalanceForm({
  action,
  customers,
  areas,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  customers: Customer[];
  /** For a customer not in the list yet, created here with the amount as opening balance. */
  areas: { id: string; name: string; warehouseName: string }[];
}) {
  const [state, formAction, saving] = useActionState(action, idleState);
  const withRequestId = useRequestId();
  const [customer, setCustomer] = useState<Customer | null>(null);
  // A name not in the list: "+ New customer" (name, phone, area); created when added.
  const [newName, setNewName] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const amount = useRef<HTMLInputElement>(null);
  const search = useRef<HTMLInputElement>(null);

  // After a successful add: clear (when the new result arrives), and back to the customer search
  // for the next one.
  const [seen, setSeen] = useState(state);
  if (state !== seen) {
    setSeen(state);
    if (state.status === "success") {
      setCustomer(null);
      setNewName(null);
      setRound((r) => r + 1);
    }
  }
  useEffect(() => {
    if (state.status === "success") search.current?.focus();
  }, [state]);
  // A customer picked: straight on to the amount (once the box is there).
  useEffect(() => {
    if (customer) amount.current?.focus();
  }, [customer]);
  useEffect(() => {
    if (newName !== null) document.getElementById("add-balance-new-phone")?.focus();
  }, [newName]);

  return (
    <form
      action={(fd) => formAction(withRequestId(fd))}
      onKeyDown={(e) => {
        // Enter in the customer search only picks (it must not send the form), and a new
        // customer's name or phone goes on to the amount: it does not add yet.
        const target = e.target as HTMLElement;
        if (e.key === "Enter" && target.getAttribute("role") === "combobox") {
          e.preventDefault();
          return;
        }
        const id = target.id;
        if (
          e.key === "Enter" &&
          (id === "add-balance-new-name" || id === "add-balance-new-phone")
        ) {
          e.preventDefault();
          amount.current?.focus();
        }
      }}
      className="bg-card space-y-2 rounded-xl border p-4"
      aria-labelledby="add-balance-heading"
    >
      <h2 id="add-balance-heading" className="font-semibold">
        Add to a customer&apos;s balance
      </h2>
      <p className="text-muted-foreground text-sm">
        An amount the customer owes from before (or asks to put on their account). It shows on their
        statement and in &ldquo;Previous balance&rdquo; on their next bill; payments clear it first.
      </p>
      <input type="hidden" name="customerId" value={customer?.id ?? ""} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-1 space-y-1">
          {newName !== null ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-40 flex-1 space-y-1">
                <label htmlFor="add-balance-new-name" className={LABEL}>
                  New customer
                </label>
                <Input
                  id="add-balance-new-name"
                  name="newCustomerName"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  maxLength={120}
                  required
                />
              </div>
              <div className="w-36 space-y-1">
                <label htmlFor="add-balance-new-phone" className={LABEL}>
                  Phone
                </label>
                <Input
                  id="add-balance-new-phone"
                  name="newCustomerPhone"
                  inputMode="tel"
                  placeholder="Optional"
                  autoComplete="off"
                />
              </div>
              <div className="w-44 space-y-1">
                <label htmlFor="add-balance-new-area" className={LABEL}>
                  Area
                </label>
                <NativeSelect id="add-balance-new-area" name="newCustomerAreaId" defaultValue="">
                  <option value="">No area</option>
                  {areas.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.warehouseName})
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <button
                type="button"
                className="text-brand mb-2 text-xs underline underline-offset-2"
                onClick={() => {
                  setNewName(null);
                  setTimeout(() => search.current?.focus(), 0);
                }}
              >
                Cancel
              </button>
            </div>
          ) : customer ? (
            <>
              <p className={LABEL}>Customer</p>
              <div className="flex h-9 items-center gap-2">
                <span className="font-medium">{customer.name}</span>
                {customer.shopName ? (
                  <span className="text-muted-foreground text-sm">· {customer.shopName}</span>
                ) : null}
                <button
                  type="button"
                  className="text-brand text-xs underline underline-offset-2"
                  onClick={() => {
                    setCustomer(null);
                    setTimeout(() => search.current?.focus(), 0);
                  }}
                >
                  Change
                </button>
              </div>
            </>
          ) : (
            <Combobox
              key={round}
              label="Customer"
              labelClassName={LABEL}
              inputRef={search}
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
              onNoMatch={(q) => setNewName(q)}
              noMatchLabel={(q) => `+ New customer “${q}”`}
              isExact={(c, q) => c.name.toLowerCase() === q}
              placeholder="Name, shop, phone or area"
            />
          )}
        </div>
        <div className="w-36 space-y-1">
          <label htmlFor="add-balance-amount" className={LABEL}>
            Amount (Rs)
          </label>
          <Input
            key={`a${round}`}
            id="add-balance-amount"
            ref={amount}
            name="amount"
            inputMode="decimal"
            autoComplete="off"
            className="tabular-nums"
            aria-invalid={fieldError(state, "amount") ? true : undefined}
          />
        </div>
        <div
          className={cn("min-w-48 flex-1 space-y-1", newName !== null && "hidden")}
          aria-hidden={newName !== null ? true : undefined}
        >
          <label htmlFor="add-balance-note" className={LABEL}>
            Note
          </label>
          <Input
            key={`n${round}`}
            id="add-balance-note"
            name="note"
            maxLength={200}
            placeholder="e.g. old khata, cash taken"
            autoComplete="off"
          />
        </div>
        <Button type="submit" disabled={saving || !(customer || newName?.trim())} className="h-9">
          {saving ? "Adding…" : "Add"}
        </Button>
      </div>
      <FieldError id="add-balance-amount-error" message={fieldError(state, "amount")} />
      {state.status !== "idle" && state.message ? (
        <p
          role={state.status === "error" ? "alert" : "status"}
          className={cn("text-sm", state.status === "error" ? "text-destructive" : "font-medium")}
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

/**
 * Order and counter-sale screens: "+ Add to balance" next to the customer's balance. It sits inside
 * the order's form, so it has no form of its own: the inputs have no names (they never go with the
 * order) and Add calls the action directly. `onAdded` reloads the customer's balance.
 */
export function AddToBalanceButton({
  action,
  customerId,
  onAdded,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  customerId: string;
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [amountText, setAmountText] = useState("");
  const [note, setNote] = useState("");
  const [result, setResult] = useState<ActionState>(idleState);
  const [saving, setSaving] = useState(false);
  const requestId = useRef<string>("");

  const add = async () => {
    setSaving(true);
    requestId.current ||= crypto.randomUUID();
    const fd = new FormData();
    fd.set("customerId", customerId);
    fd.set("amount", amountText);
    fd.set("note", note);
    fd.set("requestId", requestId.current);
    const r = await action(idleState, fd);
    setSaving(false);
    setResult(r);
    if (r.status === "success") {
      requestId.current = "";
      setAmountText("");
      setNote("");
      setOpen(false);
      onAdded();
    }
  };

  return (
    <div className="relative text-xs">
      <button
        type="button"
        className="text-brand font-medium underline-offset-2 hover:underline"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        + Add to balance
      </button>
      {result.status === "success" && result.message && !open ? (
        <span role="status" className="text-muted-foreground ml-2">
          Added.
        </span>
      ) : null}
      {open ? (
        <div className="bg-popover text-popover-foreground absolute top-full right-0 z-30 mt-1 w-80 space-y-2 rounded-md border p-3 shadow-md">
          <p className="font-medium">Add to this customer&apos;s balance</p>
          <Input
            autoFocus
            inputMode="decimal"
            placeholder="Amount (Rs)"
            aria-label="Amount to add"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                document.getElementById("add-balance-inline-note")?.focus();
              }
            }}
          />
          <Input
            id="add-balance-inline-note"
            placeholder="Note (optional)"
            aria-label="Note"
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                void add();
              } else if (e.key === "Escape") setOpen(false);
            }}
          />
          {result.status === "error" ? (
            <p role="alert" className="text-destructive">
              {fieldError(result, "amount") ?? result.message}
            </p>
          ) : null}
          <p className="text-muted-foreground">
            It goes on their account now and prints in &ldquo;Previous balance&rdquo; on this bill.
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" size="sm" disabled={saving || !amountText} onClick={add}>
              {saving ? "Adding…" : "Add"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
