-- Products sold only in whole dozens (no half dozen on orders and counter sales).
ALTER TABLE "Product" ADD COLUMN "wholeDozensOnly" BOOLEAN NOT NULL DEFAULT false;
