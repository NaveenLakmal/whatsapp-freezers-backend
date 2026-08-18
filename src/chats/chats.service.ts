import { Injectable, NotFoundException } from '@nestjs/common';
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
   * ── BUG 1: displayName resolution ────────────────────────────────────────
   * Each chat result includes a `displayName` field resolved in this priority:
   *   1. contact.name        — from the user's saved address book (most trusted)
   *   2. contact.pushName    — sender-supplied name (fallback, untrusted)
   *   3. formatJidFallback() — strips "@s.whatsapp.net", e.g. "94789418306"
   *
   * The raw `jid` is NEVER used directly as a display title in the UI.
   * ─────────────────────────────────────────────────────────────────────────
   */
  async getChats() {
    const chats = await this.prisma.chat.findMany({
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
      select: { jid: true, name: true, pushName: true, imgUrl: true },
    });

    const contactMap = new Map(contacts.map((c) => [c.jid, c]));

    return chats.map((chat) => {
      const contact = contactMap.get(chat.id);
      const displayName =
        contact?.name ??
        contact?.pushName ??
        WhatsAppService.formatJidFallback(chat.id);

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
      data: messages.map((m) => ({
        ...m,
        // BigInt is not JSON-serializable — convert to string
        timestamp: m.timestamp.toString(),
        // senderJid: who sent this message (useful for group chat UI)
        senderJid: m.senderJid ?? null,
        // wasViewOnce: true if this was originally a view-once media message
        wasViewOnce: m.wasViewOnce,
      })),
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
