"use client";

import { useActionState, useEffect } from "react";

import { SelectField, TextField } from "@/components/form/field";
import { FormMessage } from "@/components/form/form-message";
import { Button } from "@/components/ui/button";
import { type ActionState, idleState } from "@/lib/action-state";

const METHODS = [
  { value: "CASH", label: "Cash" },
  { value: "CHEQUE", label: "Cheque" },
  { value: "ONLINE", label: "Online" },
];

/** Add a repeating daily expense: category, amount a day, how paid, paid to, from which day. */
export function RecurringExpenseForm({
  action,
  categories,
  today,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  categories: { id: string; name: string }[];
  today: string;
}) {
  const [state, formAction, pending] = useActionState(action, idleState);
  return (
    <form action={formAction} className="bg-card max-w-4xl space-y-3 rounded-xl border p-4">
      <h2 className="font-semibold">Add a daily expense</h2>
      <div className="grid gap-3 sm:grid-cols-4">
        <SelectField
          state={state}
          name="categoryId"
          label="Category"
          required
          placeholder="Choose…"
          options={categories.map((c) => ({ value: c.id, label: c.name }))}
        />
        <TextField
          state={state}
          name="amount"
          label="Amount a day (Rs)"
          inputMode="decimal"
          required
        />
        <SelectField
          state={state}
          name="method"
          label="Paid by"
          options={METHODS}
          defaultValue="CASH"
        />
        <TextField
          state={state}
          name="startDate"
          label="From"
          type="date"
          required
          defaultValue={today}
        />
        <TextField
          state={state}
          name="paidTo"
          label="Paid to"
          maxLength={120}
          className="sm:col-span-2"
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
        {pending ? "Adding…" : "Add daily expense"}
      </Button>
    </form>
  );
}

const KEY = "taqseem.recurringPosted";

/**
 * Once a day per computer, adds the repeating daily expenses that are due (today's, and any days
 * the app was not opened). For users without expense access the action does nothing.
 */
export function RecurringExpensesRunner({
  run,
  today,
}: {
  run: () => Promise<number>;
  today: string;
}) {
  useEffect(() => {
    let done = false;
    try {
      done = localStorage.getItem(KEY) === today;
    } catch {
      // Storage blocked: run every time (adding twice is impossible anyway).
    }
    if (done) return;
    void run()
      .then(() => {
        try {
          localStorage.setItem(KEY, today);
        } catch {
          // Not remembered: it simply runs again next time.
        }
      })
      .catch(() => {
        // Offline or a hiccup: it is tried again on the next page.
      });
  }, [run, today]);
  return null;
}
