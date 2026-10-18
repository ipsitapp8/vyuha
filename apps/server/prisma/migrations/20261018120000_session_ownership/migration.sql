-- Session ownership. Existing sessions are deliberately NOT backfilled: their ownerId stays NULL, which
-- locks them for every instructor until an operator names an owner with `pnpm sessions:assign-owner`.

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "ownerId" TEXT;

-- CreateTable
CREATE TABLE "SessionInstructor" (
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionInstructor_pkey" PRIMARY KEY ("sessionId","userId")
);

-- CreateIndex
CREATE INDEX "SessionInstructor_userId_idx" ON "SessionInstructor"("userId");

-- CreateIndex
CREATE INDEX "Session_ownerId_idx" ON "Session"("ownerId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionInstructor" ADD CONSTRAINT "SessionInstructor_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionInstructor" ADD CONSTRAINT "SessionInstructor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

