-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "currentTick" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "speed" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE INDEX "SessionEvent_sessionId_type_idx" ON "SessionEvent"("sessionId", "type");
