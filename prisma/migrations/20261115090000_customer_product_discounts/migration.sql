-- Rates are fixed; each customer can have their own discount per product (PKR per dozen), used in
-- place of the product's discount and slabs. Earlier orders are not changed: lines that had a
-- changed rate keep it (standardRate / rateNote), and no saved discounts are made from them.

-- AlterTable
ALTER TABLE "SalesOrderLine" ADD COLUMN "customerDiscount" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "CustomerProductDiscount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "discountPerDozen" DECIMAL(14,2) NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerProductDiscount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerProductDiscount_tenantId_productId_idx" ON "CustomerProductDiscount"("tenantId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerProductDiscount_tenantId_id_key" ON "CustomerProductDiscount"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerProductDiscount_tenantId_customerId_productId_key" ON "CustomerProductDiscount"("tenantId", "customerId", "productId");

-- AddForeignKey
ALTER TABLE "CustomerProductDiscount" ADD CONSTRAINT "CustomerProductDiscount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerProductDiscount" ADD CONSTRAINT "CustomerProductDiscount_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "Customer"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerProductDiscount" ADD CONSTRAINT "CustomerProductDiscount_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A discount is never negative.
ALTER TABLE "CustomerProductDiscount" ADD CONSTRAINT "CustomerProductDiscount_discount_check" CHECK ("discountPerDozen" >= 0);
