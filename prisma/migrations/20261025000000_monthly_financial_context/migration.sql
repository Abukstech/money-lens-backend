CREATE TABLE "MonthlyFinancialContext" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "month" TEXT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'NGN',
  "takeHomeIncome" DECIMAL(20,2),
  "savingsTarget" DECIMAL(20,2),
  "spendingCoverageConfirmed" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MonthlyFinancialContext_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MonthlyFinancialContext_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MonthlyFinancialContext_userId_month_key" ON "MonthlyFinancialContext"("userId", "month");

CREATE INDEX "Transaction_userId_date_idx" ON "Transaction"("userId", "date");
CREATE INDEX "Transaction_userId_linkedTransactionId_idx" ON "Transaction"("userId", "linkedTransactionId");
