/**
 * cleanup-stray-group-chats.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE-TIME DATABASE CLEANUP SCRIPT — Bug 2 fix
 *
 * Problem: In older versions of this backend, messages sent inside a group
 * were incorrectly stored with chatId = msg.key.participant (the sender's
 * individual JID) instead of chatId = msg.key.remoteJid (the group JID).
 * This created stray chat rows keyed by participant JIDs.
 *
 * What this script does:
 *   1. Finds all messages where remoteJid ends in "@g.us" (group messages)
 *      but chatId ends in "@s.whatsapp.net" (individual JID — wrong).
 *   2. Ensures the correct group chat row exists (upserts it).
 *   3. Reassigns those messages to the correct group chatId.
 *   4. Deletes stray individual chat rows that now have zero messages,
 *      IF they were never a real 1:1 chat (i.e., they have no messages
 *      where remoteJid matches their own id).
 *
 * ⚠️  RUN THIS MANUALLY — do NOT run automatically on server startup.
 *     Always take a database backup before running.
 *
 * Usage:
 *   npx ts-node scripts/cleanup-stray-group-chats.ts
 *
 * Or compile first:
 *   npx tsc --project tsconfig.build.json && node dist/scripts/cleanup-stray-group-chats.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('=== Stray Group Chat Cleanup ===\n');

  // ── Step 1: Find stray messages ──────────────────────────────────────────
  // remoteJid is a group JID (@g.us) but chatId is an individual JID (@s.whatsapp.net)
  const strayMessages = await prisma.message.findMany({
    where: {
      remoteJid: { endsWith: '@g.us' },
      chatId: { endsWith: '@s.whatsapp.net' },
    },
    select: {
      id: true,
      chatId: true,       // incorrect (participant JID)
      remoteJid: true,    // correct (group JID)
    },
  });

  if (strayMessages.length === 0) {
    console.log('✅ No stray messages found. Database is clean.');
    return;
  }

  console.log(`Found ${strayMessages.length} stray message(s) to reassign.\n`);

  // Collect unique pairs: incorrectChatId → correctGroupJid
  const reassignMap = new Map<string, string>(); // wrongChatId → groupJid
  for (const msg of strayMessages) {
    reassignMap.set(msg.chatId, msg.remoteJid);
  }

  console.log('Stray chat → Group chat mappings:');
  for (const [wrong, correct] of reassignMap) {
    console.log(`  ${wrong} → ${correct}`);
  }
  console.log();

  // ── Step 2: Ensure correct group chat rows exist ─────────────────────────
  for (const groupJid of new Set(reassignMap.values())) {
    await prisma.chat.upsert({
      where: { id: groupJid },
      create: {
        id: groupJid,
        name: null,
        unreadCount: 0,
      },
      update: {}, // no-op if it already exists
    });
    console.log(`Ensured group chat exists: ${groupJid}`);
  }
  console.log();

  // ── Step 3: Reassign messages to correct group chatId ────────────────────
  let reassigned = 0;
  for (const [wrongChatId, groupJid] of reassignMap) {
    const result = await prisma.message.updateMany({
      where: {
        chatId: wrongChatId,
        remoteJid: groupJid,
      },
      data: {
        chatId: groupJid,
      },
    });
    console.log(
      `Reassigned ${result.count} message(s): ${wrongChatId} → ${groupJid}`,
    );
    reassigned += result.count;
  }
  console.log(`\nTotal messages reassigned: ${reassigned}\n`);

  // ── Step 4: Delete stray chat rows that are now empty ────────────────────
  // Only delete a chat if:
  //   a) It has zero messages left (all were reassigned), AND
  //   b) It has no messages where remoteJid === chatId (i.e., it was never a
  //      real 1:1 conversation — just an artifact of the bug)
  let deleted = 0;
  for (const wrongChatId of reassignMap.keys()) {
    const remainingMessages = await prisma.message.count({
      where: { chatId: wrongChatId },
    });

    if (remainingMessages > 0) {
      console.log(
        `Keeping chat ${wrongChatId} — still has ${remainingMessages} message(s) (real 1:1 chat).`,
      );
      continue;
    }

    // Double-check: was there ever a genuine 1:1 message to this JID?
    const genuine1to1Count = await prisma.message.count({
      where: {
        remoteJid: wrongChatId,
        chatId: wrongChatId,
      },
    });

    if (genuine1to1Count > 0) {
      console.log(
        `Keeping chat ${wrongChatId} — has ${genuine1to1Count} genuine 1:1 message(s).`,
      );
      continue;
    }

    await prisma.chat.delete({ where: { id: wrongChatId } });
    console.log(`Deleted stray chat: ${wrongChatId}`);
    deleted++;
  }

  console.log(`\n✅ Cleanup complete.`);
  console.log(`   Messages reassigned : ${reassigned}`);
  console.log(`   Stray chats deleted : ${deleted}`);
}

main()
  .catch((err) => {
    console.error('❌ Cleanup failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
