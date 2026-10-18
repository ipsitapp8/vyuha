-- Sign-in token versions. Existing users start at 0, so tokens already issued stay valid until that
-- user signs out (which increments the version and revokes them).

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "tokenVersion" INTEGER NOT NULL DEFAULT 0;

