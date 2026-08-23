-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVA', 'INACTIVA', 'ERROR_AUTH');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('PROCESADO', 'SIN_ADJUNTOS', 'ERROR');

-- CreateEnum
CREATE TYPE "AttachmentType" AS ENUM ('JSON', 'PDF');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('EJECUTANDO', 'COMPLETADO', 'COMPLETADO_CON_ERRORES', 'ERROR');

-- CreateTable
CREATE TABLE "email_accounts" (
    "id" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "folderName" TEXT NOT NULL,
    "imapHost" TEXT NOT NULL,
    "imapPort" INTEGER NOT NULL DEFAULT 993,
    "imapSecure" BOOLEAN NOT NULL DEFAULT true,
    "imapUser" TEXT NOT NULL,
    "imapPassEnc" TEXT NOT NULL,
    "mailbox" TEXT NOT NULL DEFAULT 'INBOX',
    "syncInterval" INTEGER NOT NULL DEFAULT 300,
    "syncFromDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUid" INTEGER NOT NULL DEFAULT 0,
    "uidValidity" BIGINT,
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVA',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_emails" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "uid" INTEGER NOT NULL,
    "subject" TEXT NOT NULL DEFAULT '',
    "senderName" TEXT NOT NULL DEFAULT '',
    "senderEmail" TEXT NOT NULL,
    "recipients" TEXT[],
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "monthFolder" TEXT NOT NULL,
    "attachmentCount" INTEGER NOT NULL DEFAULT 0,
    "status" "EmailStatus" NOT NULL,
    "errorDetail" TEXT,

    CONSTRAINT "processed_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "fileType" "AttachmentType" NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_logs" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "emailsFound" INTEGER NOT NULL DEFAULT 0,
    "emailsProcessed" INTEGER NOT NULL DEFAULT 0,
    "emailsSkipped" INTEGER NOT NULL DEFAULT 0,
    "filesDownloaded" INTEGER NOT NULL DEFAULT 0,
    "status" "SyncStatus" NOT NULL DEFAULT 'EJECUTANDO',
    "errorDetail" TEXT,
    "trigger" TEXT NOT NULL DEFAULT 'scheduler',

    CONSTRAINT "sync_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_accounts_email_key" ON "email_accounts"("email");

-- CreateIndex
CREATE INDEX "processed_emails_accountId_receivedAt_idx" ON "processed_emails"("accountId", "receivedAt");

-- CreateIndex
CREATE INDEX "processed_emails_senderEmail_idx" ON "processed_emails"("senderEmail");

-- CreateIndex
CREATE INDEX "processed_emails_status_idx" ON "processed_emails"("status");

-- CreateIndex
CREATE UNIQUE INDEX "processed_emails_accountId_messageId_key" ON "processed_emails"("accountId", "messageId");

-- CreateIndex
CREATE INDEX "attachments_emailId_idx" ON "attachments"("emailId");

-- CreateIndex
CREATE INDEX "attachments_sha256_idx" ON "attachments"("sha256");

-- CreateIndex
CREATE INDEX "sync_logs_accountId_startedAt_idx" ON "sync_logs"("accountId", "startedAt");

-- AddForeignKey
ALTER TABLE "processed_emails" ADD CONSTRAINT "processed_emails_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "email_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "processed_emails"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_logs" ADD CONSTRAINT "sync_logs_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "email_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
