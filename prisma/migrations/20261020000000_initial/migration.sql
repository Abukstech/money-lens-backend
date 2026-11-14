-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Statement" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'extracting',
    "errorCode" TEXT,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Statement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "statementId" TEXT,
    "sourceRow" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "direction" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "balance" DECIMAL(20,2),
    "referenceHash" TEXT,
    "accountHash" TEXT,
    "recipientHash" TEXT,
    "page" INTEGER,
    "row" INTEGER,
    "validationIssues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "category" TEXT NOT NULL DEFAULT 'unknown',
    "suggestedCategory" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "source" TEXT NOT NULL DEFAULT 'none',
    "confidence" DOUBLE PRECISION,
    "merchantId" TEXT,
    "channel" TEXT,
    "economicType" TEXT NOT NULL DEFAULT 'unresolved',
    "linkedTransactionId" TEXT,
    "jevInvoked" BOOLEAN NOT NULL DEFAULT false,
    "modelVersion" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "ontologyVersion" TEXT NOT NULL DEFAULT '1.0.0',
    "policyVersion" TEXT NOT NULL DEFAULT '1.0.0-conservative',
    "datasetChecksum" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "classifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassificationRevision" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "suggestedCategory" TEXT,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "merchantId" TEXT,
    "channel" TEXT,
    "economicType" TEXT NOT NULL,
    "jevInvoked" BOOLEAN NOT NULL,
    "modelVersion" TEXT,
    "ontologyVersion" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "datasetChecksum" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "reasonCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassificationRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipientRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "recipientHash" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "minAmount" DECIMAL(20,2) NOT NULL,
    "maxAmount" DECIMAL(20,2) NOT NULL,
    "narrationTokens" TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipientRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleRevision" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "minAmount" DECIMAL(20,2) NOT NULL,
    "maxAmount" DECIMAL(20,2) NOT NULL,
    "narrationTokens" TEXT[],
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassificationTask" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lastDispatchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassificationTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Statement_userId_fingerprint_key" ON "Statement"("userId", "fingerprint");

-- CreateIndex
CREATE INDEX "Transaction_userId_status_idx" ON "Transaction"("userId", "status");

-- CreateIndex
CREATE INDEX "Transaction_userId_recipientHash_idx" ON "Transaction"("userId", "recipientHash");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_userId_sourceRow_key" ON "Transaction"("userId", "sourceRow");

-- CreateIndex
CREATE UNIQUE INDEX "ClassificationRevision_transactionId_revision_key" ON "ClassificationRevision"("transactionId", "revision");

-- CreateIndex
CREATE INDEX "RecipientRule_userId_recipientHash_idx" ON "RecipientRule"("userId", "recipientHash");

-- CreateIndex
CREATE UNIQUE INDEX "RuleRevision_ruleId_version_key" ON "RuleRevision"("ruleId", "version");

-- CreateIndex
CREATE INDEX "ClassificationTask_status_lastDispatchedAt_idx" ON "ClassificationTask"("status", "lastDispatchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClassificationTask_transactionId_revision_key" ON "ClassificationTask"("transactionId", "revision");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Statement" ADD CONSTRAINT "Statement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "Statement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassificationRevision" ADD CONSTRAINT "ClassificationRevision_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipientRule" ADD CONSTRAINT "RecipientRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleRevision" ADD CONSTRAINT "RuleRevision_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "RecipientRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassificationTask" ADD CONSTRAINT "ClassificationTask_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

