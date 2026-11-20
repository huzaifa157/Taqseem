"use client";

import { useActionState } from "react";

import { FieldError, FormMessage } from "@/components/form/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type ActionState, fieldError, idleState } from "@/lib/action-state";

/** The time of the daily backup (Settings → Cloud sync). */
export function BackupTimeForm({
  action,
  time,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  time: string;
}) {
  const [state, formAction, pending] = useActionState(action, idleState);
  return (
    <form action={formAction} className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1.5">
          <Label htmlFor="backup-time">Daily backup at</Label>
          <Input
            id="backup-time"
            name="time"
            type="time"
            defaultValue={time}
            required
            className="w-36"
            aria-invalid={fieldError(state, "time") ? true : undefined}
          />
        </div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Saving…" : "Save time"}
        </Button>
      </div>
      <FieldError id="backup-time-error" message={fieldError(state, "time")} />
      <FormMessage state={state} />
    </form>
  );
}
