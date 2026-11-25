"use client";

import { useActionState, useRef, useState } from "react";

import { SelectField, TextField } from "@/components/form/field";
import { FormMessage } from "@/components/form/form-message";
import { Button } from "@/components/ui/button";
import { type ActionState, idleState } from "@/lib/action-state";
import { CASH_KIND_LABEL, CASH_MOVE_KINDS } from "@/lib/validation/cash";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/**
 * The action with a client request id (CLAUDE.md rule 7): made on the first submit, reused when
 * Save is pressed again after a timeout, and dropped once saved so the next entry is new.
 */
function useIdempotent(action: Action) {
  const requestId = useRef<string | null>(null);
  const [state, formAction, pending] = useActionState(async (prev: ActionState, fd: FormData) => {
    requestId.current ??= crypto.randomUUID();
    fd.set("requestId", requestId.current);
    const result = await action(prev, fd);
    if (result.status === "success") requestId.current = null;
    return result;
  }, idleState);
  return [state, formAction, pending] as const;
}

const TABS = [
  { id: "count", label: "Count cash" },
  { id: "move", label: "Cash in / out" },
  { id: "opening", label: "Opening cash" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/** One form at a time: count the drawer, cash put in or taken out, or the opening cash. */
export function CashForms({
  today,
  hasOpening,
  expected,
  actions,
}: {
  today: string;
  hasOpening: boolean;
  /** Today's cash by the book, as text. */
  expected: string;
  actions: { opening: Action; move: Action; count: Action };
}) {
  const [tab, setTab] = useState<Tab>(hasOpening ? "count" : "opening");
  return (
    <section className="bg-card max-w-4xl space-y-3 rounded-xl border p-4">
      <div role="tablist" aria-label="What to enter" className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            variant={tab === t.id ? "default" : "outline"}
            size="sm"
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </Button>
        ))}
      </div>
      {tab === "opening" ? (
        <OpeningForm action={actions.opening} today={today} hasOpening={hasOpening} />
      ) : tab === "move" ? (
        <MoveForm action={actions.move} today={today} />
      ) : (
        <CountForm action={actions.count} today={today} expected={expected} />
      )}
    </section>
  );
}

function OpeningForm({
  action,
  today,
  hasOpening,
}: {
  action: Action;
  today: string;
  hasOpening: boolean;
}) {
  const [state, formAction, pending] = useIdempotent(action);
  return (
    <form action={formAction} className="space-y-3">
      <p className="text-muted-foreground text-sm">
        The cash in the drawer at the start of the day you begin the book. Each day after starts
        from the day before&apos;s closing cash.
        {hasOpening ? " Saving a new one replaces the current opening cash." : ""}
      </p>
      <div className="grid gap-3 sm:grid-cols-4">
        <TextField
          state={state}
          name="entryDate"
          label="Cash on the morning of"
          type="date"
          required
          max={today}
          defaultValue={today}
        />
        <TextField
          state={state}
          name="amount"
          label="Cash in hand (Rs)"
          inputMode="decimal"
          required
          autoFocus
        />
        <TextField
          state={state}
          name="note"
          label="Note"
          maxLength={300}
          className="sm:col-span-2"
        />
      </div>
      <FormMessage state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save opening cash"}
      </Button>
    </form>
  );
}

function MoveForm({ action, today }: { action: Action; today: string }) {
  const [state, formAction, pending] = useIdempotent(action);
  return (
    <form action={formAction} className="space-y-3">
      <p className="text-muted-foreground text-sm">
        Cash that is not a sale, payment or expense: the owner puts cash in or takes it out, or cash
        goes to or comes from the bank.
      </p>
      <div className="grid gap-3 sm:grid-cols-4">
        <SelectField
          state={state}
          name="kind"
          label="What"
          required
          placeholder="Choose…"
          autoFocus
          options={CASH_MOVE_KINDS.map((k) => ({ value: k, label: CASH_KIND_LABEL[k] }))}
        />
        <TextField state={state} name="amount" label="Amount (Rs)" inputMode="decimal" required />
        <TextField
          state={state}
          name="entryDate"
          label="Date"
          type="date"
          required
          max={today}
          defaultValue={today}
        />
        <TextField state={state} name="note" label="Note" maxLength={300} />
      </div>
      <FormMessage state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}

function CountForm({
  action,
  today,
  expected,
}: {
  action: Action;
  today: string;
  expected: string;
}) {
  const [state, formAction, pending] = useActionState(action, idleState);
  return (
    <form action={formAction} className="space-y-3">
      <p className="text-muted-foreground text-sm">
        Count the cash in the drawer at night and type the total. The book says{" "}
        <span className="text-foreground font-medium">{expected}</span> for today.
      </p>
      <div className="grid gap-3 sm:grid-cols-4">
        <TextField
          state={state}
          name="counted"
          label="Cash counted (Rs)"
          inputMode="decimal"
          required
          autoFocus
        />
        <TextField
          state={state}
          name="countDate"
          label="Day"
          type="date"
          required
          max={today}
          defaultValue={today}
        />
        <TextField
          state={state}
          name="note"
          label="Note"
          maxLength={300}
          className="sm:col-span-2"
        />
        <label className="flex items-start gap-2 text-sm sm:col-span-4">
          <input type="checkbox" name="correct" defaultChecked className="mt-1" />
          <span>
            <span className="font-medium">Set the book to the count</span>: a shortage or extra is
            entered as a count difference, so tomorrow starts from the cash really there.
          </span>
        </label>
      </div>
      <FormMessage state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save count"}
      </Button>
    </form>
  );
}
