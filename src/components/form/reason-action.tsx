"use client";

import { useActionState, useState } from "react";

import { FieldError, FormMessage } from "@/components/form/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type ActionState, fieldError, idleState } from "@/lib/action-state";

/**
 * A reversing action (cancel, reverse, correct) that asks for a reason before running. `date`:
 * also asks for a date (e.g. the right date of a trip).
 */
export function ReasonAction({
  action,
  label,
  description,
  date,
  destructive = true,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  label: string;
  description: string;
  date?: { label: string; defaultValue: string };
  destructive?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(action, idleState);
  if (state.status === "success") return <FormMessage state={state} />;
  if (!open) {
    return (
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }
  const error = fieldError(state, "reason");
  return (
    <form action={formAction} className="max-w-xl space-y-2 rounded-lg border p-3">
      <p className="text-muted-foreground text-sm">{description}</p>
      {date ? (
        <div className="space-y-1">
          <label htmlFor="reason-date" className="text-sm font-medium">
            {date.label}
          </label>
          <Input
            id="reason-date"
            name="date"
            type="date"
            required
            defaultValue={date.defaultValue}
            className="w-44"
            aria-invalid={fieldError(state, "date") ? true : undefined}
          />
          <FieldError id="reason-date-error" message={fieldError(state, "date")} />
        </div>
      ) : null}
      <label htmlFor="reason" className="text-sm font-medium">
        Reason
      </label>
      <Input
        id="reason"
        name="reason"
        required
        minLength={3}
        maxLength={300}
        autoFocus={!date}
        aria-invalid={error ? true : undefined}
      />
      <FieldError id="reason-error" message={error} />
      <FormMessage state={state} />
      <div className="flex gap-2">
        <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={pending}>
          {pending ? "Working…" : label}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Keep it
        </Button>
      </div>
    </form>
  );
}
