-- Expenses added by themselves every day (lunch, petrol), and monthly costs (rent, salary)
-- spread over the days of their month in daily profit.
-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "recurringExpenseId" TEXT,
ADD COLUMN     "spreadOverMonth" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "RecurringExpense" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL DEFAULT 'CASH',
    "paidTo" TEXT,
    "note" TEXT,
    "startDate" DATE NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringExpense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecurringExpense_tenantId_isActive_idx" ON "RecurringExpense"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "RecurringExpense_tenantId_id_key" ON "RecurringExpense"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Expense_tenantId_recurringExpenseId_expenseDate_key" ON "Expense"("tenantId", "recurringExpenseId", "expenseDate");

-- AddForeignKey
ALTER TABLE "RecurringExpense" ADD CONSTRAINT "RecurringExpense_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringExpense" ADD CONSTRAINT "RecurringExpense_tenantId_categoryId_fkey" FOREIGN KEY ("tenantId", "categoryId") REFERENCES "ExpenseCategory"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_tenantId_recurringExpenseId_fkey" FOREIGN KEY ("tenantId", "recurringExpenseId") REFERENCES "RecurringExpense"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

