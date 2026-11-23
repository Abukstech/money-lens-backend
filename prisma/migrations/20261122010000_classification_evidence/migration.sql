ALTER TABLE "Transaction" ADD COLUMN "reasonCode" TEXT, ADD COLUMN "evidence" JSONB;
ALTER TABLE "ClassificationRevision" ADD COLUMN "evidence" JSONB;
ALTER TABLE "StatementExtractionRow" ADD COLUMN "accountHash" TEXT, ADD COLUMN "recipientHash" TEXT;
ALTER TABLE "Transaction" ALTER COLUMN "ontologyVersion" SET DEFAULT '1.1.0';
ALTER TABLE "Transaction" ALTER COLUMN "policyVersion" SET DEFAULT '2.0.0-evidence-first';
