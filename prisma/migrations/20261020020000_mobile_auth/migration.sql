ALTER TABLE "User" ADD COLUMN "firstName" TEXT, ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
CREATE TABLE "EmailChallenge" (
 "id" TEXT PRIMARY KEY, "email" TEXT NOT NULL, "purpose" TEXT NOT NULL,
 "codeHash" TEXT NOT NULL, "eligible" BOOLEAN NOT NULL, "attempts" INTEGER NOT NULL DEFAULT 0,
 "expiresAt" TIMESTAMP(3) NOT NULL, "consumedAt" TIMESTAMP(3), "grantHash" TEXT,
 "grantExpiresAt" TIMESTAMP(3), "grantConsumedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "EmailChallenge_email_purpose_key" ON "EmailChallenge"("email", "purpose");
CREATE UNIQUE INDEX "EmailChallenge_grantHash_key" ON "EmailChallenge"("grantHash");
CREATE TABLE "AuthRateBucket" (
 "key" TEXT PRIMARY KEY, "count" INTEGER NOT NULL, "windowStartedAt" TIMESTAMP(3) NOT NULL,
 "lastRequestedAt" TIMESTAMP(3) NOT NULL
);
