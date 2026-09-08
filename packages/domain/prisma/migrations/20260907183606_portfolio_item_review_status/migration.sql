-- CreateEnum
CREATE TYPE "PortfolioItemStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "WeeklyPortfolioItem" ADD COLUMN     "status" "PortfolioItemStatus" NOT NULL DEFAULT 'PROPOSED';

