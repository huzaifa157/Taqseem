-- A customer's damage deducted from a counter sale's bill ("− Damage" on the sale).
-- AlterTable
ALTER TABLE "DamageReturn" ADD COLUMN     "salesOrderId" TEXT;

-- CreateIndex
CREATE INDEX "DamageReturn_tenantId_salesOrderId_idx" ON "DamageReturn"("tenantId", "salesOrderId");

-- AddForeignKey
ALTER TABLE "DamageReturn" ADD CONSTRAINT "DamageReturn_tenantId_salesOrderId_fkey" FOREIGN KEY ("tenantId", "salesOrderId") REFERENCES "SalesOrder"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

