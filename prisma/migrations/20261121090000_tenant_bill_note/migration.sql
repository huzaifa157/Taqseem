-- A note printed at the foot of every bill page (e.g. the returns policy); blank prints nothing.
ALTER TABLE "Tenant" ADD COLUMN "billNote" VARCHAR(200);
