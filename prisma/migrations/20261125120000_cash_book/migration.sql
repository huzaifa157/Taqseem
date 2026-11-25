-- Cash book: opening cash, cash added or taken out, bank deposits and withdrawals, and the
-- nightly cash count.
-- CreateEnum
CREATE TYPE "CashEntryKind" AS ENUM ('OPENING', 'ADDED', 'TAKEN_OUT', 'BANK_DEPOSIT', 'BANK_WITHDRAWAL', 'COUNT_DIFFERENCE');

-- CreateEnum
CREATE TYPE "CashDirection" AS ENUM ('IN', 'OUT');

-- CreateTable
CREATE TABLE "CashEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "entryDate" DATE NOT NULL,
    "kind" "CashEntryKind" NOT NULL,
    "direction" "CashDirection" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "status" "PostingStatus" NOT NULL DEFAULT 'POSTED',
    "reversedAt" TIMESTAMP(3),
    "reversalReason" TEXT,
    "requestId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashCount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "countDate" DATE NOT NULL,
    "counted" DECIMAL(14,2) NOT NULL,
    "expected" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashCount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CashEntry_tenantId_entryDate_idx" ON "CashEntry"("tenantId", "entryDate");

-- CreateIndex
CREATE UNIQUE INDEX "CashEntry_tenantId_id_key" ON "CashEntry"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CashEntry_tenantId_number_key" ON "CashEntry"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "CashEntry_tenantId_requestId_key" ON "CashEntry"("tenantId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "CashCount_tenantId_id_key" ON "CashCount"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CashCount_tenantId_countDate_key" ON "CashCount"("tenantId", "countDate");

-- AddForeignKey
ALTER TABLE "CashEntry" ADD CONSTRAINT "CashEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashCount" ADD CONSTRAINT "CashCount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
