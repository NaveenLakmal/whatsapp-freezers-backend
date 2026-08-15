-- CreateTable
CREATE TABLE "chats" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "baileysId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "remoteJid" TEXT NOT NULL,
    "fromMe" BOOLEAN NOT NULL,
    "messageType" TEXT NOT NULL DEFAULT 'TEXT',
    "body" TEXT,
    "mediaUrl" TEXT,
    "mediaLocalPath" TEXT,
    "mimetype" TEXT,
    "fileName" TEXT,
    "timestamp" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "messages_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "media_files" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "filename" TEXT NOT NULL,
    "originalName" TEXT,
    "mimetype" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "localPath" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "messages_baileysId_key" ON "messages"("baileysId");

-- CreateIndex
CREATE INDEX "messages_chatId_timestamp_idx" ON "messages"("chatId", "timestamp");

-- CreateIndex
CREATE INDEX "messages_baileysId_idx" ON "messages"("baileysId");

-- CreateIndex
CREATE UNIQUE INDEX "media_files_filename_key" ON "media_files"("filename");
