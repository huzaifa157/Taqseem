-- Customer names are unique in a business, ignoring capitals and extra spaces
-- ("Ali Traders" = "ali  traders"). The app checks first for a readable message
-- (services/master/customers.ts, customerWithName); this index is the guarantee.
-- Hand-written: Prisma cannot express an expression index and does not drop it.

-- Existing duplicates keep their first customer's name; later ones get " (2)", " (3)" ...
WITH ranked AS (
  SELECT "id",
         row_number() OVER (
           PARTITION BY "tenantId", lower(regexp_replace(btrim("name"), '\s+', ' ', 'g'))
           ORDER BY "createdAt", "id"
         ) AS n
  FROM "Customer"
)
UPDATE "Customer" c
SET "name" = regexp_replace(btrim(c."name"), '\s+', ' ', 'g') || ' (' || r.n || ')'
FROM ranked r
WHERE c."id" = r."id" AND r.n > 1;

CREATE UNIQUE INDEX "Customer_tenantId_name_ci_key"
  ON "Customer" ("tenantId", lower(regexp_replace(btrim("name"), '\s+', ' ', 'g')));
