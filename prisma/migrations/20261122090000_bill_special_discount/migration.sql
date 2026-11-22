-- A special discount on the whole bill (rupees), typed under the order / counter sale grid. It is
-- split over the bill's companies in proportion to their amounts (see splitSpecialDiscount).
ALTER TABLE "SalesOrder" ADD COLUMN "specialDiscount" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_specialDiscount_check" CHECK ("specialDiscount" >= 0);
