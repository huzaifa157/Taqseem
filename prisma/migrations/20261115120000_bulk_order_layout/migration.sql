-- The bulk order sheet: per warehouse, which products are its columns and in which order.
-- A new table only; nothing existing changes.

-- CreateTable
CREATE TABLE "BulkOrderLayout" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "productIds" TEXT[],
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BulkOrderLayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BulkOrderLayout_tenantId_id_key" ON "BulkOrderLayout"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BulkOrderLayout_tenantId_warehouseId_key" ON "BulkOrderLayout"("tenantId", "warehouseId");

-- AddForeignKey
ALTER TABLE "BulkOrderLayout" ADD CONSTRAINT "BulkOrderLayout_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkOrderLayout" ADD CONSTRAINT "BulkOrderLayout_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "Warehouse"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

