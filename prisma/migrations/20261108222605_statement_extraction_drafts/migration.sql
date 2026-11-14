-- CreateEnum
CREATE TYPE "ExtractionDraftStatus" AS ENUM ('DRAFT', 'NEEDS_REVIEW', 'VALIDATED', 'VERIFIED', 'RELEASED');

-- CreateEnum
CREATE TYPE "ExtractionReviewDecision" AS ENUM ('candidate_pass', 'needs_review');

-- CreateEnum
CREATE TYPE "ExtractionDirection" AS ENUM ('debit', 'credit');

-- CreateEnum
CREATE TYPE "ExtractionReleaseMode" AS ENUM ('automatic_candidate', 'manual_verified');

-- CreateTable
CREATE TABLE "StatementExtractionDraft" (
    "id" TEXT NOT NULL,
    "accountScopeId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "sourceStatementId" TEXT,
    "documentHash" VARCHAR(64) NOT NULL,
    "revision" VARCHAR(64) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "ExtractionDraftStatus" NOT NULL DEFAULT 'DRAFT',
    "reviewDecision" "ExtractionReviewDecision" NOT NULL,
    "reviewReasons" JSONB NOT NULL,
    "extractionEvidence" JSONB NOT NULL,
    "releasedRevision" VARCHAR(64),
    "releaseMode" "ExtractionReleaseMode",
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StatementExtractionDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatementExtractionRow" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "date" VARCHAR(10) NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "direction" "ExtractionDirection" NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "balance" DECIMAL(20,2),
    "reference" TEXT,
    "accountIdentifier" TEXT,
    "recipientIdentifier" TEXT,
    "page" INTEGER NOT NULL,
    "row" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StatementExtractionRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatementExtractionApproval" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "approvedRevision" VARCHAR(64) NOT NULL,
    "sourceDocumentChecked" BOOLEAN NOT NULL,
    "allTransactionsConfirmed" BOOLEAN NOT NULL,
    "confirmedTransactionCount" INTEGER NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatementExtractionApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StatementExtractionDraft_accountScopeId_status_idx" ON "StatementExtractionDraft"("accountScopeId", "status");

-- CreateIndex
CREATE INDEX "StatementExtractionDraft_sourceStatementId_idx" ON "StatementExtractionDraft"("sourceStatementId");

-- CreateIndex
CREATE INDEX "StatementExtractionRow_draftId_idx" ON "StatementExtractionRow"("draftId");

-- CreateIndex
CREATE UNIQUE INDEX "StatementExtractionRow_draftId_position_key" ON "StatementExtractionRow"("draftId", "position");

-- CreateIndex
CREATE INDEX "StatementExtractionApproval_draftId_approvedAt_idx" ON "StatementExtractionApproval"("draftId", "approvedAt");

-- AddForeignKey
ALTER TABLE "StatementExtractionRow" ADD CONSTRAINT "StatementExtractionRow_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "StatementExtractionDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatementExtractionApproval" ADD CONSTRAINT "StatementExtractionApproval_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "StatementExtractionDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
