import { Injectable, NotFoundException } from '@nestjs/common';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { SendMessageDto } from './dto/send-message.dto';
import { PaginationDto } from './dto/pagination.dto';

@Injectable()
export class ChatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsAppService,
  ) {}

  /**
   * Returns all known chats, ordered by most recent message first.
   *
   * ── Contact Name Resolution Priority ─────────────────────────────────────
   * Each chat result includes a `displayName` field resolved in this strict priority:
   *   1st priority: Phone-saved contact name from user's address book (nameSource = 'phone_contact')
   *   2nd priority: Group subject (for group chats, nameSource = 'group_subject' or chat.name)
   *   3rd priority: Contact's own self-set WhatsApp display name (contact.pushName / contact.notify)
   *   4th priority: Formatted phone number from JID fallback (e.g. "94789418306")
   * ─────────────────────────────────────────────────────────────────────────
   */
  async getChats() {
    const chats = await this.prisma.chat.findMany({
      // ── ISSUE 3: Exclude group chats (@g.us) ──────────────────────────────
      // Prisma doesn't support endsWith in a where filter for string fields,
      // so we use NOT contains the suffix via a raw string filter workaround:
      // filter out any id containing '@g.us'.
      where: { NOT: { id: { contains: '@g.us' } } },
      orderBy: { lastMessageAt: 'desc' },
      include: {
        _count: {
          select: { messages: true },
        },
      },
    });

    if (chats.length === 0) return [];

    // Batch-fetch contacts for all chat JIDs in a single query
    const jids = chats.map((c) => c.id);
    const contacts = await this.prisma.contact.findMany({
      where: { jid: { in: jids } },
      select: {
        jid: true,
        name: true,
        pushName: true,
        notify: true,
        imgUrl: true,
        nameSource: true,
      },
    });

    const contactMap = new Map(contacts.map((c) => [c.jid, c]));

    const formatJid = (jid: string): string => {
      if (typeof WhatsAppService.formatJidFallback === 'function') {
        return WhatsAppService.formatJidFallback(jid);
      }
      return jid.replace(/@s\.whatsapp\.net$/, '').replace(/@.*$/, '');
    };

    return chats.map((chat) => {
      const contact = contactMap.get(chat.id);
      const isGroup = chat.id.endsWith('@g.us');

      let displayName: string;

      // 1st priority: Phone-saved contact name
      if (
        contact?.name &&
        (contact.nameSource === 'phone_contact' ||
          contact.nameSource === 'contact')
      ) {
        displayName = contact.name;
      }
      // 2nd priority: Group subject (for group chats only)
      else if (isGroup && (chat.name || contact?.name)) {
        displayName = chat.name ?? contact?.name ?? formatJid(chat.id);
      }
      // Phone contact name fallback if nameSource was not set but name exists
      else if (
        contact?.name &&
        contact.nameSource !== 'whatsapp_pushname' &&
        contact.nameSource !== 'pushName'
      ) {
        displayName = contact.name;
      }
      // 3rd priority: Contact's own self-set WhatsApp display name (pushName / notify)
      else if (contact?.pushName || contact?.notify) {
        displayName = (contact.pushName ?? contact.notify)!;
      }
      // Chat table fallback name
      else if (chat.name) {
        displayName = chat.name;
      }
      // 4th priority: Formatted phone number from JID
      else {
        displayName = formatJid(chat.id);
      }

      return {
        ...chat,
        displayName,
        avatarUrl: contact?.imgUrl ?? null,
      };
    });
  }

  /**
   * Returns paginated messages for a specific chat JID.
   * Ordered newest-first for easy append-on-scroll in the Flutter app.
   *
   * Each message includes `wasViewOnce` so the Flutter UI can render a
   * "view once" badge on media that was originally ephemeral.
   */
  async getMessages(jid: string, pagination: PaginationDto) {
    // ── ISSUE 3: Reject group JID lookups ────────────────────────────────────────
    if (jid.endsWith('@g.us')) {
      throw new NotFoundException(`Group chats are not supported: ${jid}`);
    }

    const chat = await this.prisma.chat.findUnique({ where: { id: jid } });
    if (!chat) {
      throw new NotFoundException(`Chat not found for JID: ${jid}`);
    }

    const messages = await this.prisma.message.findMany({
      where: { chatId: jid },
      orderBy: { timestamp: 'desc' },
      take: pagination.limit ?? 50,
      skip: pagination.offset ?? 0,
    });

    const total = await this.prisma.message.count({ where: { chatId: jid } });

    return {
      data: messages.map((m) => {
        // ── Bug 2 fix: view-once / local-media URL resolution ─────────────────
        // The backend stores media at a local path (e.g. /app/uploads/uuid.jpg).
        // The Flutter app cannot access the filesystem directly, so we convert
        // that path into a relative HTTP URL (/media/uuid.jpg) that is served
        // by GET /media/:filename — protected by the same API key guard.
        const mediaUrl: string | null =
          m.mediaUrl ??
          (m.mediaLocalPath
            ? `/media/${path.basename(m.mediaLocalPath)}`
            : null);

        return {
          ...m,
          // BigInt is not JSON-serializable — convert to string
          timestamp: m.timestamp.toString(),
          // Resolved HTTP URL for any locally stored media
          mediaUrl,
          // senderJid: who sent this message (useful for group chat UI)
          senderJid: m.senderJid ?? null,
          // wasViewOnce: true if this was originally a view-once media message
          wasViewOnce: m.wasViewOnce,
        };
      }),
      total,
      limit: pagination.limit ?? 50,
      offset: pagination.offset ?? 0,
    };
  }

  /**
   * Sends a message to a JID via WhatsApp and returns the saved record.
   */
  async sendMessage(jid: string, dto: SendMessageDto) {
    const type = dto.type ?? 'text';

    try {
      if (type === 'text') {
        if (!dto.text?.trim()) {
          throw new NotFoundException(
            'Text content is required for text messages.',
          );
        }
        await this.whatsapp.sendTextMessage(jid, dto.text);
      } else if (type === 'image') {
        if (!dto.mediaUrl)
          throw new NotFoundException(
            'mediaUrl is required for image messages.',
          );
        await this.whatsapp.sendImageMessage(
          jid,
          { url: dto.mediaUrl },
          dto.text,
        );
      } else {
        if (!dto.mediaUrl)
          throw new NotFoundException(
            'mediaUrl is required for media messages.',
          );
        await this.whatsapp.sendMediaMessage(jid, {
          type: type,
          media: { url: dto.mediaUrl },
          caption: dto.text,
          mimetype: dto.mimetype,
          fileName: dto.fileName,
        });
      }
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      // WhatsApp not connected — surface a clean error
      const { ServiceUnavailableException } = await import('@nestjs/common');
      throw new ServiceUnavailableException(
        (err as Error).message ??
          'WhatsApp is not connected. Scan the QR at GET /connection/qr first.',
      );
    }

    // Return the last persisted message for this chat
    const saved = await this.prisma.message.findFirst({
      where: { chatId: jid, fromMe: true },
      orderBy: { createdAt: 'desc' },
    });

    if (saved) {
      return { ...saved, timestamp: saved.timestamp.toString() };
    }
    return { success: true };
  }

  /**
   * Marks all messages in a chat as read.
   *
   * ⚠️  PRESENCE NOTE: This triggers read receipts to be sent.
   * It is ONLY invoked by an explicit POST /chats/:jid/read from the Flutter app.
   * This is NEVER called automatically.
   */
  async markAsRead(jid: string): Promise<{ success: boolean }> {
    await this.whatsapp.markChatAsRead(jid);
    return { success: true };
  }
}
