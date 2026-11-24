import type { Metadata } from "next";

import { ConfirmAction } from "@/components/form/confirm-action";
import { RecurringExpenseForm } from "@/components/expenses/recurring-expenses";
import { RequirePermission } from "@/components/layout/no-access";
import { BackLink, PageHeader } from "@/components/layout/page-header";
import { DataTable, EmptyRow, Td, Th } from "@/components/list/data-table";
import { Badge } from "@/components/ui/badge";
import { businessToday, formatDate, toDateInput } from "@/lib/dates";
import { formatMoney } from "@/lib/format";
import { requireTenantContext } from "@/server/auth/session";
import { saveRecurringExpenseAction, setRecurringActiveAction } from "@/server/expense-actions";
import { listRecurringExpenses } from "@/server/services/recurring-expenses";

export const metadata: Metadata = { title: "Repeating expenses" };

export default function RepeatingExpensesPage() {
  return (
    <RequirePermission permission="expenses.manage">
      <BackLink href="/expenses">Expenses</BackLink>
      <PageHeader
        title="Repeating expenses"
        description="Daily costs (lunch, petrol, a daily wage) entered by themselves every day. Each day's entry shows in Expenses and can be cancelled on its own. Monthly costs (rent, salary): add them once when paid and tick Monthly cost, so daily profit counts a share each day."
      />
      <Repeating />
    </RequirePermission>
  );
}

async function Repeating() {
  const ctx = await requireTenantContext("expenses.manage");
  const [items, categories] = await Promise.all([
    listRecurringExpenses(ctx),
    ctx.db.expenseCategory.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);
  const perDay = items.filter((i) => i.isActive).reduce((s, i) => s + Number(i.amount), 0);
  return (
    <div className="space-y-6">
      <RecurringExpenseForm
        action={saveRecurringExpenseAction}
        categories={categories}
        today={toDateInput(businessToday())}
      />
      <section className="space-y-2">
        <h2 className="font-medium">
          Every day{" "}
          <span className="text-muted-foreground font-normal">
            · {formatMoney(perDay.toFixed(2))} a day in all
          </span>
        </h2>
        <DataTable>
          <thead>
            <tr>
              <Th>Category</Th>
              <Th>Paid to / note</Th>
              <Th className="text-right">A day</Th>
              <Th>From</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <EmptyRow colSpan={5}>No repeating expenses yet.</EmptyRow>
            ) : null}
            {items.map((i) => (
              <tr key={i.id}>
                <Td>
                  {i.category.name}
                  {i.isActive ? null : (
                    <Badge variant="outline" className="ml-2">
                      Stopped
                    </Badge>
                  )}
                </Td>
                <Td>{[i.paidTo, i.note].filter(Boolean).join(" · ") || "—"}</Td>
                <Td className="text-right tabular-nums">{formatMoney(i.amount)}</Td>
                <Td>{formatDate(i.startDate)}</Td>
                <Td className="text-right">
                  <ConfirmAction
                    action={setRecurringActiveAction.bind(null, i.id, !i.isActive)}
                    label={i.isActive ? "Stop" : "Start again"}
                    confirm={
                      i.isActive
                        ? `Stop adding ${i.category.name} every day? Days already added stay.`
                        : `Start adding ${i.category.name} every day again (missed days are filled in)?`
                    }
                  />
                </Td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </section>
    </div>
  );
}
