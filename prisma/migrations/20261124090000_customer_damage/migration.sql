-- Customer damage (Damage screen): damaged goods a customer brings back, goods given in
-- exchange, and the credit / charge on their account. Claims link back to the entry.
-- CreateEnum
CREATE TYPE "DamageLineKind" AS ENUM ('DAMAGED', 'REPLACEMENT');

-- AlterEnum
ALTER TYPE "ClaimType" ADD VALUE 'CUSTOMER_DAMAGE';

-- AlterEnum
ALTER TYPE "StockMovementType" ADD VALUE 'DAMAGE_REPLACEMENT';

-- AlterTable
ALTER TABLE "CompanyClaim" ADD COLUMN     "damageReturnId" TEXT;

-- CreateTable
CREATE TABLE "DamageReturn" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "customerId" TEXT NOT NULL,
    "returnDate" DATE NOT NULL,
    "damagedAmount" DECIMAL(14,2) NOT NULL,
    "replacementAmount" DECIMAL(14,2) NOT NULL,
    "status" "PostingStatus" NOT NULL DEFAULT 'POSTED',
    "reversedAt" TIMESTAMP(3),
    "reversalReason" TEXT,
    "note" TEXT,
    "requestId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DamageReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DamageReturnLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "damageReturnId" TEXT NOT NULL,
    "kind" "DamageLineKind" NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "rate" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "DamageReturnLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DamageReturn_tenantId_customerId_returnDate_idx" ON "DamageReturn"("tenantId", "customerId", "returnDate");

-- CreateIndex
CREATE UNIQUE INDEX "DamageReturn_tenantId_id_key" ON "DamageReturn"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DamageReturn_tenantId_number_key" ON "DamageReturn"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "DamageReturn_tenantId_requestId_key" ON "DamageReturn"("tenantId", "requestId");

-- CreateIndex
CREATE INDEX "DamageReturnLine_tenantId_damageReturnId_idx" ON "DamageReturnLine"("tenantId", "damageReturnId");

-- CreateIndex
CREATE INDEX "DamageReturnLine_tenantId_productId_idx" ON "DamageReturnLine"("tenantId", "productId");

-- AddForeignKey
ALTER TABLE "CompanyClaim" ADD CONSTRAINT "CompanyClaim_tenantId_damageReturnId_fkey" FOREIGN KEY ("tenantId", "damageReturnId") REFERENCES "DamageReturn"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DamageReturn" ADD CONSTRAINT "DamageReturn_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DamageReturn" ADD CONSTRAINT "DamageReturn_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "Customer"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DamageReturnLine" ADD CONSTRAINT "DamageReturnLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DamageReturnLine" ADD CONSTRAINT "DamageReturnLine_tenantId_damageReturnId_fkey" FOREIGN KEY ("tenantId", "damageReturnId") REFERENCES "DamageReturn"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DamageReturnLine" ADD CONSTRAINT "DamageReturnLine_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

