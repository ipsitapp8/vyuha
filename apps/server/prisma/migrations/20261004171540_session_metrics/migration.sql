-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isDemoBot" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "SessionMetric" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "avgDecisionLatencyMs" DOUBLE PRECISION,
    "latencyUnderJammingMs" DOUBLE PRECISION,
    "brierScore" DOUBLE PRECISION,
    "spoofsChallengedPct" DOUBLE PRECISION,
    "reportGradingAccuracy" DOUBLE PRECISION,

    CONSTRAINT "SessionMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SessionMetric_userId_endedAt_idx" ON "SessionMetric"("userId", "endedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SessionMetric_sessionId_userId_key" ON "SessionMetric"("sessionId", "userId");

-- AddForeignKey
ALTER TABLE "SessionMetric" ADD CONSTRAINT "SessionMetric_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionMetric" ADD CONSTRAINT "SessionMetric_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
