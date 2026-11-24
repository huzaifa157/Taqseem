import { Suspense } from "react";

import { RecurringExpensesRunner } from "@/components/expenses/recurring-expenses";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { businessToday, toDateInput } from "@/lib/dates";
import { postDueRecurringExpensesAction } from "@/server/expense-actions";
import { requireTenantUser } from "@/server/auth/session";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-screen">
      <AppSidebar />
      <main className="min-w-0 flex-1 p-3 sm:p-6 print:p-0">
        {/* The sidebar is part of the static shell; page content waits for the session check. */}
        <Suspense fallback={<p className="text-muted-foreground text-sm">Loading…</p>}>
          <SessionGate>{children}</SessionGate>
        </Suspense>
      </main>
    </div>
  );
}

/** Every page in the app requires a signed-in tenant user (redirects to login otherwise). */
async function SessionGate({ children }: { children: React.ReactNode }) {
  await requireTenantUser();
  return (
    <>
      {children}
      {/* Once a day: the repeating daily expenses that are due (expense access only). */}
      <RecurringExpensesRunner
        run={postDueRecurringExpensesAction}
        today={toDateInput(businessToday())}
      />
    </>
  );
}
