-- One account per customer: customer ledger entries and payment allocations no longer carry a
-- company (CLAUDE.md rule 3, changed). Earlier entries keep the company they were posted with;
-- every customer figure is read as one balance.
ALTER TABLE "LedgerEntry" DROP CONSTRAINT "LedgerEntry_party_check";
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_party_check" CHECK (
  ("partyType" = 'CUSTOMER' AND "customerId" IS NOT NULL AND "staffId" IS NULL)
  OR ("partyType" = 'COMPANY' AND "companyId" IS NOT NULL AND "customerId" IS NULL AND "staffId" IS NULL)
  OR ("partyType" = 'STAFF' AND "staffId" IS NOT NULL AND "customerId" IS NULL AND "companyId" IS NULL)
);

ALTER TABLE "PaymentAllocation" ALTER COLUMN "companyId" DROP NOT NULL;
