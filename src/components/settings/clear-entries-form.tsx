"use client";

import { useActionState } from "react";

import { TextField } from "@/components/form/field";
import { FormMessage } from "@/components/form/form-message";
import { Button } from "@/components/ui/button";
import { type ActionState, idleState } from "@/lib/action-state";

/** Settings → Clear entries: a typed confirmation before the trial entries are removed. */
export function ClearEntriesForm({
  action,
  word,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  word: string;
}) {
  const [state, formAction, pending] = useActionState(action, idleState);
  return (
    <form action={formAction} className="space-y-3">
      <TextField
        state={state}
        name="confirm"
        label={`Type ${word} to confirm`}
        autoComplete="off"
        required
        hint="This cannot be undone."
      />
      <FormMessage state={state} />
      <Button type="submit" variant="destructive" disabled={pending}>
        {pending ? "Clearing…" : "Clear entries"}
      </Button>
    </form>
  );
}
