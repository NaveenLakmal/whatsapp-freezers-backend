/**
 * scripts/purge-groups.ts
 *
 * One-shot script to delete all group-chat data from the database.
 * Run ONCE after deploying the @g.us filtering fix to clean up historic data.
 *
 * Usage:
 *   npx ts-node --project tsconfig.json scripts/purge-groups.ts
 */

import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();

  try {
    console.log('Purging group messages (@g.us)…');
    const deletedMessages = await prisma.message.deleteMany({
      where: { chatId: { contains: '@g.us' } },
    });
    console.log(`  Deleted ${deletedMessages.count} message(s).`);

    console.log('Purging group contacts (@g.us)…');
    const deletedContacts = await prisma.contact.deleteMany({
      where: { jid: { contains: '@g.us' } },
    });
    console.log(`  Deleted ${deletedContacts.count} contact(s).`);

    console.log('Purging group chats (@g.us)…');
    const deletedChats = await prisma.chat.deleteMany({
      where: { id: { contains: '@g.us' } },
    });
    console.log(`  Deleted ${deletedChats.count} chat(s).`);

    console.log('\n✅  Done — all group data removed.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Purge failed:', err);
  process.exit(1);
});
