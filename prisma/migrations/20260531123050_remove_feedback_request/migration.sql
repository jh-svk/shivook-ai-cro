/*
  Warnings:

  - You are about to drop the `feedback_requests` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "feedback_requests" DROP CONSTRAINT "feedback_requests_shopId_fkey";

-- DropTable
DROP TABLE "feedback_requests";
