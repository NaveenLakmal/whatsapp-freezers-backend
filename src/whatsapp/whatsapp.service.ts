import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import makeWASocket, {
  ConnectionState,
  DisconnectReason,
  WAMessage,
  WASocket,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidGroup,
  proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { BaileysAuthStore } from './baileys-auth.store';

// String enums matching the values stored in the DB (see schema.prisma comments)
const MessageType = {
  TEXT: 'TEXT',
  IMAGE: 'IMAGE',
  VIDEO: 'VIDEO',
  AUDIO: 'AUDIO',
  DOCUMENT: 'DOCUMENT',
  STICKER: 'STICKER',
  LOCATION: 'LOCATION',
  CONTACT: 'CONTACT',
  UNKNOWN: 'UNKNOWN',
} as const;
type MessageType = (typeof MessageType)[keyof typeof MessageType];

const MessageStatus = {
  PENDING: 'PENDING',
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  READ: 'READ',
  FAILED: 'FAILED',
} as const;
type MessageStatus = (typeof MessageStatus)[keyof typeof MessageStatus];

// Name source priority constants — controls which source may overwrite which.
// Priority order (highest → lowest): contact > group_subject > pushName
const NameSource = {
  CONTACT: 'contact',
  GROUP_SUBJECT: 'group_subject',
  PUSH_NAME: 'pushName',
} as const;
type NameSource = (typeof NameSource)[keyof typeof NameSource];

// Numeric priority map — higher wins.
const NAME_SOURCE_PRIORITY: Record<string, number> = {
  [NameSource.CONTACT]: 3,
  [NameSource.GROUP_SUBJECT]: 2,
  [NameSource.PUSH_NAME]: 1,
};

// ---------------------------------------------------------------------------
// Connection status type — shared with the rest of the application
// ---------------------------------------------------------------------------
export type ConnectionStatus = 'connecting' | 'open' | 'close' | 'qr';

export interface ConnectionInfo {
  status: ConnectionStatus;
  /** Base64-encoded QR code PNG (only present when status === 'qr') */
  qr?: string;
  /** ISO timestamp of the last status change */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// WhatsAppService
// ---------------------------------------------------------------------------
/**
 * WhatsAppService
 *
 * Core integration with the Baileys multi-device library.
 * Manages the WebSocket connection to WhatsApp, handles lifecycle events,
 * persists messages to the database, and exposes methods for sending messages.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PRESENCE POLICY — CRITICAL
 * ─────────────────────────────────────────────────────────────────────────────
 * This service is intentionally designed to NEVER trigger WhatsApp presence
 * updates ("last seen", "online", "composing", "recording").
 *
 * Functions that are deliberately NOT called:
 *   - sock.sendPresenceUpdate()  ← NEVER called anywhere in this file
 *   - sock.presenceSubscribe()   ← NEVER called anywhere in this file
 *
 * The socket is initialized with:
 *   - markOnlineOnConnect: false  ← prevents auto "online" on connection
 *
 * Read receipts are also NOT sent automatically. The markChatAsRead()
 * method exists as an explicit, opt-in action only.
 *
 * Do NOT add calls to sendPresenceUpdate() or presenceSubscribe() in the
 * future without a full understanding of the privacy implications.
 * ─────────────────────────────────────────────────────────────────────────────
 */
@Injectable()
export class WhatsAppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppService.name);

  private sock: WASocket | null = null;
  private authStore: BaileysAuthStore;
  private connectionInfo: ConnectionInfo = {
    status: 'close',
    updatedAt: new Date().toISOString(),
  };

  /** Exponential backoff state for auto-reconnect */
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_DELAY_MS = 60_000; // 1 minute cap
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Whether the service is shutting down (prevents reconnect loops) */
  private isShuttingDown = false;

  private readonly authStateDir: string;
  private readonly mediaUploadDir: string;
  private readonly saveViewOnceMedia: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {
    this.authStateDir =
      this.config.get<string>('whatsapp.authStateDir') ?? './auth_state';
    this.mediaUploadDir =
      this.config.get<string>('media.uploadDir') ?? './uploads';
    this.saveViewOnceMedia =
      this.config.get<boolean>('media.saveViewOnceMedia') ?? true;
    this.authStore = new BaileysAuthStore(this.authStateDir);
    this.ensureMediaDir();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.isShuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.sock?.end(undefined);
    this.logger.log('WhatsApp socket closed.');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Connection
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Initializes the Baileys WebSocket connection to WhatsApp.
   * Registers all event listeners and handles credential persistence.
   */
  async connect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const { state, saveCreds } = await this.authStore.getAuthState();
    const { version } = await fetchLatestBaileysVersion();

    this.logger.log(`Connecting with Baileys version: ${version.join('.')}`);

    this.sock = makeWASocket({
      version,
      auth: state,

      // ── PRESENCE POLICY ──────────────────────────────────────────────────
      // markOnlineOnConnect: false — prevents Baileys from calling
      // sendPresenceUpdate('available') immediately on connection open.
      // This is the FIRST layer of presence suppression.
      // ─────────────────────────────────────────────────────────────────────
      markOnlineOnConnect: false,

      // Disable link preview generation (not needed, reduces bandwidth)
      generateHighQualityLinkPreview: false,

      // Suppress verbose Baileys internal logs in production
      logger: this.createBaileysLogger(),

      // Do not print QR to terminal — we serve it via the REST API instead
      printQRInTerminal: false,
    });

    // ── PRESENCE: Monkey-patch sendPresenceUpdate to a permanent no-op ────
    //
    // WHY THIS IS NECESSARY:
    // markOnlineOnConnect: false only stops the initial 'available' broadcast
    // on connect. However, Baileys can internally call sendPresenceUpdate()
    // during other operations (e.g. during message sends in some versions).
    // WhatsApp's server also interprets an active companion-device WebSocket
    // as "online" if ANY presence update of type 'available' is received.
    //
    // This patch completely disables the function at the socket level,
    // making it IMPOSSIBLE for any code path — internal or external —
    // to send a presence update of any kind ('available', 'composing',
    // 'recording', 'paused', 'unavailable').
    //
    // DO NOT REMOVE THIS — removing it will cause WhatsApp to show
    // the account as "online" while the backend is running.
    // ─────────────────────────────────────────────────────────────────────
    this.sock.sendPresenceUpdate = async (
      _type: any,
      _jid?: string,
    ): Promise<void> => {
      // PRESENCE: intentionally suppressed — this is a permanent no-op.
      // WhatsApp 'online', 'composing', 'recording', 'unavailable' are NEVER sent.
      return;
    };

    // ── PRESENCE: presenceSubscribe is also blocked ───────────────────────
    this.sock.presenceSubscribe = async (
      _jid: string,
      _participants?: string[],
    ): Promise<void> => {
      // PRESENCE: intentionally suppressed — presenceSubscribe is never called.
      this.logger.warn(
        'PRESENCE GUARD: presenceSubscribe() was called and blocked.',
      );
      return;
    };

    // ── Credential persistence ───────────────────────────────────────────
    this.sock.ev.on('creds.update', saveCreds);

    // ── Connection lifecycle ─────────────────────────────────────────────
    this.sock.ev.on('connection.update', (update) => {
      void this.handleConnectionUpdate(update);
    });

    // ── Incoming & outgoing messages ─────────────────────────────────────
    this.sock.ev.on('messages.upsert', (upsert) => {
      void this.handleMessagesUpsert(upsert);
    });

    // ── Message status updates (delivered, read receipts from others) ────
    this.sock.ev.on('messages.update', (updates) => {
      void this.handleMessageStatusUpdates(updates);
    });

    // ── Chat metadata (names, unread counts, etc.) ───────────────────────
    this.sock.ev.on('chats.upsert', (chats) => {
      void this.handleChatsUpsert(chats);
    });

    this.sock.ev.on('chats.update', (updates) => {
      void this.handleChatsUpdate(updates);
    });

    // ── BUG 1: Contact name resolution ───────────────────────────────────
    // Listen for contact sync events from Baileys. These carry the user's
    // own saved address-book names — the highest-trust name source.
    this.sock.ev.on('contacts.upsert', (contacts) => {
      void this.handleContactsUpsert(contacts);
    });

    this.sock.ev.on('contacts.update', (updates) => {
      void this.handleContactsUpdate(updates);
    });

    // ── BUG 1: Group name resolution ─────────────────────────────────────
    // Group subjects (names) come from these events and are stored in the
    // Contact table under nameSource='group_subject'.
    this.sock.ev.on('groups.upsert', (groups) => {
      void this.handleGroupsUpsert(groups);
    });

    this.sock.ev.on('groups.update', (updates) => {
      void this.handleGroupsUpdate(updates);
    });
  }

  /**
   * Handles WhatsApp connection state changes.
   */
  private async handleConnectionUpdate(
    update: Partial<ConnectionState>,
  ): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    // QR code is available — user needs to scan with phone
    if (qr) {
      this.logger.log('QR code generated — scan with WhatsApp on your phone.');
      const qrBase64 = await this.qrToBase64(qr);
      this.setConnectionInfo({ status: 'qr', qr: qrBase64 });
    }

    if (connection === 'connecting') {
      this.logger.log('Connecting to WhatsApp...');
      this.setConnectionInfo({ status: 'connecting' });
    }

    if (connection === 'open') {
      this.logger.log('✅ WhatsApp connection established.');
      this.reconnectAttempts = 0; // reset backoff on successful connect
      this.setConnectionInfo({ status: 'open' });

      // ── PRESENCE: We do NOT call sendPresenceUpdate('available') here ──
      // The standard pattern in many Baileys examples is to call
      // sendPresenceUpdate('available') on connection open. We intentionally
      // omit this to keep the account's presence hidden.
      // ──────────────────────────────────────────────────────────────────
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const reason =
        DisconnectReason[
          statusCode as unknown as keyof typeof DisconnectReason
        ] ?? 'Unknown';

      this.logger.warn(
        `Connection closed. Status: ${statusCode}, Reason: ${reason}`,
      );
      this.setConnectionInfo({ status: 'close' });

      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      if (isLoggedOut) {
        this.logger.warn(
          'Logged out from WhatsApp. Auth state cleared. Restarting connection to generate a new QR code...',
        );
        this.authStore.clearAuthState();
        this.reconnectAttempts = 0;
        if (!this.isShuttingDown) {
          // Restart connection after 1.5s so Baileys generates a fresh QR code
          this.reconnectTimer = setTimeout(() => {
            void this.connect();
          }, 1500);
        }
      } else if (!this.isShuttingDown) {
        // Any other disconnect reason — auto-reconnect with exponential backoff
        this.scheduleReconnect();
      }
    }
  }

  /**
   * Schedules an auto-reconnect attempt with exponential backoff.
   */
  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = Math.min(
      1000 * 2 ** this.reconnectAttempts,
      this.MAX_RECONNECT_DELAY_MS,
    );
    this.logger.log(
      `Scheduling reconnect attempt #${this.reconnectAttempts} in ${delay / 1000}s...`,
    );

    this.reconnectTimer = setTimeout(async () => {
      this.logger.log(`Reconnect attempt #${this.reconnectAttempts}`);
      await this.connect();
    }, delay);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Message Handling
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Handles the 'messages.upsert' event fired by Baileys when new messages
   * arrive (incoming) or are sent (outgoing, after server acknowledgement).
   */
  private async handleMessagesUpsert(upsert: {
    messages: WAMessage[];
    type: string;
  }): Promise<void> {
    // Only process 'notify' type — these are actual new messages
    if (upsert.type !== 'notify') return;

    for (const msg of upsert.messages) {
      try {
        await this.persistMessage(msg);
      } catch (err) {
        // Log error without message content for privacy in production
        this.logger.error(
          `Failed to persist message [id=${msg.key.id}]: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Persists a WhatsApp message to the database and emits a WebSocket event.
   *
   * ── BUG 2 FIX: Chat grouping key ─────────────────────────────────────────
   * The CHAT a message belongs to is ALWAYS determined by msg.key.remoteJid.
   * - For group messages: remoteJid is the group JID (ending in @g.us)
   * - For 1:1 messages:  remoteJid is the contact JID (@s.whatsapp.net)
   *
   * msg.key.participant is ONLY used to record WHO sent the message within
   * a group (stored as senderJid). It is NEVER used as the chatId.
   * ─────────────────────────────────────────────────────────────────────────
   */
  private async persistMessage(msg: WAMessage): Promise<void> {
    const jid = msg.key.remoteJid;
    if (!jid) return;

    // Skip broadcast/status messages
    if (isJidBroadcast(jid)) return;
    if (jid === 'status@broadcast') return;

    const baileysId = msg.key.id ?? '';
    const fromMe = msg.key.fromMe ?? false;
    const timestamp = String(
      typeof msg.messageTimestamp === 'number'
        ? msg.messageTimestamp
        : ((msg.messageTimestamp as any)?.toNumber?.() ??
            Math.floor(Date.now() / 1000)),
    );

    // ── BUG 2: senderJid — WHO sent the message (not used as chatId) ──────
    // For group messages: msg.key.participant holds the sender's JID
    // For 1:1 messages:  participant is undefined; sender is remoteJid itself
    const senderJid = fromMe
      ? 'me'
      : (msg.key.participant ?? jid);

    // Upsert the chat record — always keyed by remoteJid (jid), never by participant
    await this.upsertChat(jid, msg);

    // ── BUG 1: Capture pushName as a low-priority fallback display name ───
    // pushName is sent by the remote party and is UNTRUSTED — it must never
    // overwrite a name that came from the user's own contact list.
    if (msg.pushName && !fromMe) {
      // For group messages, update the sender's contact entry (not the group)
      const contactJid = msg.key.participant ?? jid;
      await this.upsertContactPushName(contactJid, msg.pushName);
    }

    // Extract message content (also handles view-once unwrapping)
    const { messageType, body, mediaUrl, mimetype, fileName, wasViewOnce } =
      this.extractMessageContent(msg);

    // Download and store media if present.
    // For view-once messages: download immediately without waiting for the
    // app to "open" it through WhatsApp's normal flow. This ensures the media
    // is permanently saved regardless of WhatsApp's ephemeral mechanism.
    let mediaLocalPath: string | undefined;
    const shouldDownloadMedia =
      messageType !== MessageType.TEXT &&
      messageType !== MessageType.UNKNOWN &&
      msg.message;

    if (shouldDownloadMedia) {
      if (!wasViewOnce || this.saveViewOnceMedia) {
        // For view-once, use the unwrapped message object so downloadMediaMessage
        // can locate the correct media keys inside the wrapper.
        mediaLocalPath = await this.downloadAndStoreMedia(
          msg,
          messageType,
          mimetype,
        );
      }
    }

    // Upsert to avoid duplicates on reconnect replays
    const saved = await this.prisma.message.upsert({
      where: { baileysId },
      create: {
        baileysId,
        chatId: jid,
        remoteJid: jid,
        fromMe,
        messageType,
        body: body ?? null,
        mediaUrl: mediaUrl ?? null,
        mediaLocalPath: mediaLocalPath ?? null,
        mimetype: mimetype ?? null,
        fileName: fileName ?? null,
        timestamp,
        status: MessageStatus.SENT,
        senderJid,
        wasViewOnce,
      },
      update: {
        status: MessageStatus.SENT,
        // Update senderJid in case of replay with more info
        senderJid,
      },
    });

    // ── PRESENCE: We do NOT call sendPresenceUpdate() or readMessages() ──
    // Read receipts are never sent automatically. The Flutter app can
    // trigger read receipts via POST /chats/:jid/read if desired.
    // ─────────────────────────────────────────────────────────────────────

    // Emit real-time event to connected Flutter clients
    this.events.emit('message.new', {
      id: saved.id,
      baileysId: saved.baileysId,
      chatId: saved.chatId,
      remoteJid: saved.remoteJid,
      fromMe: saved.fromMe,
      messageType: saved.messageType,
      body: saved.body,
      mediaUrl: saved.mediaUrl,
      mediaLocalPath: saved.mediaLocalPath,
      mimetype: saved.mimetype,
      fileName: saved.fileName,
      timestamp: saved.timestamp.toString(),
      status: saved.status,
      senderJid: saved.senderJid,
      wasViewOnce: saved.wasViewOnce,
    });
  }

  /**
   * Handles message status updates (delivered/read receipts from recipients).
   */
  private async handleMessageStatusUpdates(
    updates: proto.IWebMessageInfo[],
  ): Promise<void> {
    for (const update of updates) {
      const baileysId = update.key?.id;
      const statusNum = update.status;
      if (!baileysId || statusNum == null) continue;

      let status: MessageStatus | null = null;
      if (statusNum === proto.WebMessageInfo.Status.DELIVERY_ACK) {
        status = MessageStatus.DELIVERED;
      } else if (statusNum === proto.WebMessageInfo.Status.READ) {
        status = MessageStatus.READ;
      } else if (statusNum === proto.WebMessageInfo.Status.ERROR) {
        status = MessageStatus.FAILED;
      }

      if (!status) continue;

      try {
        await this.prisma.message.updateMany({
          where: { baileysId },
          data: { status },
        });

        this.events.emit('message.status', { baileysId, status });
      } catch {
        this.logger.error(`Failed to update message status [id=${baileysId}]`);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Chat Sync
  // ─────────────────────────────────────────────────────────────────────────

  private async handleChatsUpsert(chats: any[]): Promise<void> {
    for (const chat of chats) {
      try {
        await this.prisma.chat.upsert({
          where: { id: chat.id },
          create: {
            id: chat.id,
            name: chat.name ?? null,
            unreadCount: chat.unreadCount ?? 0,
          },
          update: {
            name: chat.name ?? undefined,
            unreadCount: chat.unreadCount ?? undefined,
          },
        });
      } catch {
        this.logger.error(`Failed to upsert chat [jid=${chat.id}]`);
      }
    }
  }

  private async handleChatsUpdate(updates: any[]): Promise<void> {
    for (const update of updates) {
      try {
        await this.prisma.chat.update({
          where: { id: update.id },
          data: {
            name: update.name ?? undefined,
            unreadCount: update.unreadCount ?? undefined,
          },
        });
      } catch {
        // Chat may not exist yet — ignore
      }
    }
  }

  private async upsertChat(jid: string, msg: WAMessage): Promise<void> {
    const ts =
      typeof msg.messageTimestamp === 'number'
        ? msg.messageTimestamp
        : ((msg.messageTimestamp as any)?.toNumber?.() ??
          Math.floor(Date.now() / 1000));
    const lastMessageAt = new Date(ts * 1000);

    await this.prisma.chat.upsert({
      where: { id: jid },
      create: {
        id: jid,
        name: null,
        unreadCount: msg.key.fromMe ? 0 : 1,
        lastMessageAt,
      },
      update: {
        lastMessageAt,
        unreadCount: msg.key.fromMe ? undefined : { increment: 1 },
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BUG 1: Contact Name Resolution
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Handles 'contacts.upsert' — bulk contact sync from the user's address book.
   * These are the MOST TRUSTED names (nameSource = 'contact').
   * They always overwrite any lower-priority name (pushName, group_subject).
   */
  private async handleContactsUpsert(contacts: any[]): Promise<void> {
    for (const contact of contacts) {
      if (!contact.id) continue;
      try {
        const name: string | null =
          contact.name ?? contact.notify ?? null;
        await this.upsertContact(
          contact.id,
          name,
          NameSource.CONTACT,
          contact.imgUrl ?? null,
        );
      } catch (err) {
        this.logger.error(
          `Failed to upsert contact [jid=${contact.id}]: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Handles 'contacts.update' — partial updates to existing contacts.
   */
  private async handleContactsUpdate(updates: any[]): Promise<void> {
    for (const update of updates) {
      if (!update.id) continue;
      try {
        const name: string | null = update.name ?? update.notify ?? null;
        if (name) {
          await this.upsertContact(update.id, name, NameSource.CONTACT, update.imgUrl ?? undefined);
        } else if (update.imgUrl !== undefined) {
          // Only image update — don't overwrite name
          await this.prisma.contact.updateMany({
            where: { jid: update.id },
            data: { imgUrl: update.imgUrl },
          });
        }
      } catch (err) {
        this.logger.error(
          `Failed to update contact [jid=${update.id}]: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Handles 'groups.upsert' — new group metadata (including the group subject/name).
   * nameSource = 'group_subject' — lower priority than 'contact' but higher than 'pushName'.
   */
  private async handleGroupsUpsert(groups: any[]): Promise<void> {
    for (const group of groups) {
      if (!group.id) continue;
      try {
        const name: string | null = group.subject ?? null;
        await this.upsertContact(group.id, name, NameSource.GROUP_SUBJECT);
      } catch (err) {
        this.logger.error(
          `Failed to upsert group contact [jid=${group.id}]: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Handles 'groups.update' — updates to existing group metadata.
   */
  private async handleGroupsUpdate(updates: any[]): Promise<void> {
    for (const update of updates) {
      if (!update.id) continue;
      try {
        if (update.subject) {
          await this.upsertContact(update.id, update.subject, NameSource.GROUP_SUBJECT);
        }
      } catch (err) {
        this.logger.error(
          `Failed to update group contact [jid=${update.id}]: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Upserts a pushName from an incoming message into the Contact table.
   *
   * pushName is UNTRUSTED — it is provided by the sender and can be spoofed.
   * It is ONLY stored if no higher-priority name (from the user's address book
   * or group subject) already exists for this JID.
   */
  private async upsertContactPushName(
    jid: string,
    pushName: string,
  ): Promise<void> {
    try {
      const existing = await this.prisma.contact.findUnique({
        where: { jid },
        select: { nameSource: true },
      });

      const existingPriority = existing?.nameSource
        ? (NAME_SOURCE_PRIORITY[existing.nameSource] ?? 0)
        : 0;
      const pushNamePriority = NAME_SOURCE_PRIORITY[NameSource.PUSH_NAME];

      if (existingPriority > pushNamePriority) {
        // A better name already exists — do not downgrade it with pushName
        return;
      }

      await this.prisma.contact.upsert({
        where: { jid },
        create: {
          jid,
          pushName,
          nameSource: NameSource.PUSH_NAME,
        },
        update: {
          pushName,
          // Only update nameSource if we're the best source so far
          nameSource: NameSource.PUSH_NAME,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to upsert pushName for [jid=${jid}]: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Core contact upsert — respects name source priority.
   * A name from a higher-priority source will never be overwritten by a
   * lower-priority source.
   */
  private async upsertContact(
    jid: string,
    name: string | null,
    source: NameSource,
    imgUrl?: string | null,
  ): Promise<void> {
    const incomingPriority = NAME_SOURCE_PRIORITY[source] ?? 0;

    const existing = await this.prisma.contact.findUnique({
      where: { jid },
      select: { nameSource: true },
    });

    const existingPriority = existing?.nameSource
      ? (NAME_SOURCE_PRIORITY[existing.nameSource] ?? 0)
      : 0;

    const shouldUpdateName = name !== null && incomingPriority >= existingPriority;

    await this.prisma.contact.upsert({
      where: { jid },
      create: {
        jid,
        name: name,
        nameSource: name ? source : null,
        imgUrl: imgUrl ?? null,
      },
      update: {
        ...(shouldUpdateName ? { name, nameSource: source } : {}),
        ...(imgUrl !== undefined ? { imgUrl } : {}),
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Message Content Extraction
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Extracts message type, body, and media metadata from a WAMessage.
   *
   * ── VIEW-ONCE HANDLING ────────────────────────────────────────────────────
   * View-once messages are wrapped in one of three container types:
   *   - viewOnceMessage          (original)
   *   - viewOnceMessageV2        (updated protocol)
   *   - viewOnceMessageV2Extension (extended variant)
   *
   * We unwrap the container to get the inner imageMessage or videoMessage,
   * then set wasViewOnce = true so callers know to handle it specially.
   *
   * ⚠️  PRIVACY NOTE: By capturing view-once media, this code bypasses the
   * sender's expectation that the media disappears after one view. This
   * feature should only be used with a full understanding of the privacy
   * implications for whoever sent the media. The SAVE_VIEW_ONCE_MEDIA=false
   * config flag can be used to disable persistent storage of view-once media.
   * ─────────────────────────────────────────────────────────────────────────
   */
  private extractMessageContent(msg: WAMessage): {
    messageType: MessageType;
    body?: string;
    mediaUrl?: string;
    mimetype?: string;
    fileName?: string;
    wasViewOnce: boolean;
  } {
    let m = msg.message;
    if (!m) return { messageType: MessageType.UNKNOWN, wasViewOnce: false };

    // ── Unwrap view-once containers ───────────────────────────────────────
    let wasViewOnce = false;

    const viewOnceInner =
      m.viewOnceMessage?.message ??
      m.viewOnceMessageV2?.message ??
      (m as any).viewOnceMessageV2Extension?.message ??
      null;

    if (viewOnceInner) {
      wasViewOnce = true;
      // Non-null assertion: viewOnceInner is truthy here, so it is a valid IMessage
      m = viewOnceInner!;
      this.logger.log(
        `Detected view-once message [id=${msg.key.id}] — ${this.saveViewOnceMedia ? 'capturing media' : 'media capture disabled by config'}`,
      );
    }
    // Guard: if the unwrapped inner message is somehow empty, bail out early
    if (!m) return { messageType: MessageType.UNKNOWN, wasViewOnce };
    // ─────────────────────────────────────────────────────────────────────

    if (m.conversation || m.extendedTextMessage) {
      return {
        messageType: MessageType.TEXT,
        body: m.conversation ?? m.extendedTextMessage?.text ?? undefined,
        wasViewOnce,
      };
    }
    if (m.imageMessage) {
      return {
        messageType: MessageType.IMAGE,
        body: m.imageMessage.caption ?? undefined,
        mimetype: m.imageMessage.mimetype ?? undefined,
        wasViewOnce,
      };
    }
    if (m.videoMessage) {
      return {
        messageType: MessageType.VIDEO,
        body: m.videoMessage.caption ?? undefined,
        mimetype: m.videoMessage.mimetype ?? undefined,
        wasViewOnce,
      };
    }
    if (m.audioMessage) {
      return {
        messageType: MessageType.AUDIO,
        mimetype: m.audioMessage.mimetype ?? undefined,
        wasViewOnce,
      };
    }
    if (m.documentMessage) {
      return {
        messageType: MessageType.DOCUMENT,
        body: m.documentMessage.caption ?? undefined,
        mimetype: m.documentMessage.mimetype ?? undefined,
        fileName: m.documentMessage.fileName ?? undefined,
        wasViewOnce,
      };
    }
    if (m.stickerMessage) {
      return {
        messageType: MessageType.STICKER,
        mimetype: m.stickerMessage.mimetype ?? undefined,
        wasViewOnce,
      };
    }
    if (m.locationMessage) {
      return {
        messageType: MessageType.LOCATION,
        body: `${m.locationMessage.degreesLatitude},${m.locationMessage.degreesLongitude}`,
        wasViewOnce,
      };
    }

    return { messageType: MessageType.UNKNOWN, wasViewOnce };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Media Downloading
  // ─────────────────────────────────────────────────────────────────────────

  private async downloadAndStoreMedia(
    msg: WAMessage,
    type: MessageType,
    mimetype?: string,
  ): Promise<string | undefined> {
    try {
      const buffer = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        {
          logger: this.createBaileysLogger(),
          reuploadRequest: this.sock!.updateMediaMessage.bind(this.sock),
        },
      );

      if (!buffer || !Buffer.isBuffer(buffer)) return undefined;

      const ext = this.mimetypeToExtension(mimetype ?? '', type);
      const filename = `${crypto.randomUUID()}${ext}`;
      const filePath = path.join(this.mediaUploadDir, filename);
      fs.writeFileSync(filePath, buffer);

      // Store media file metadata
      await this.prisma.mediaFile.create({
        data: {
          filename,
          mimetype: mimetype ?? 'application/octet-stream',
          size: buffer.length,
          localPath: filePath,
        },
      });

      return filePath;
    } catch (err) {
      this.logger.error(
        `Failed to download media for message: ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  private mimetypeToExtension(mimetype: string, type: MessageType): string {
    if (mimetype.includes('jpeg') || mimetype.includes('jpg')) return '.jpg';
    if (mimetype.includes('png')) return '.png';
    if (mimetype.includes('webp')) return '.webp';
    if (mimetype.includes('mp4')) return '.mp4';
    if (mimetype.includes('ogg')) return '.ogg';
    if (mimetype.includes('mp3')) return '.mp3';
    if (mimetype.includes('pdf')) return '.pdf';
    const defaults: Record<string, string> = {
      [MessageType.IMAGE]: '.jpg',
      [MessageType.VIDEO]: '.mp4',
      [MessageType.AUDIO]: '.ogg',
      [MessageType.DOCUMENT]: '.bin',
      [MessageType.STICKER]: '.webp',
    };
    return defaults[type] ?? '.bin';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API — Sending Messages
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Sends a plain text message.
   *
   * PRESENCE NOTE: sendPresenceUpdate('composing') is intentionally NOT
   * called before or after sending. The typing indicator will NOT appear.
   */
  async sendTextMessage(
    jid: string,
    text: string,
  ): Promise<WAMessage | undefined> {
    this.ensureConnected();

    // ── PRESENCE: composing update intentionally NOT sent ─────────────────
    // Standard pattern: await this.sock.sendPresenceUpdate('composing', jid)
    // We deliberately skip this to prevent the "typing..." indicator from
    // appearing in the recipient's WhatsApp.
    // ─────────────────────────────────────────────────────────────────────

    const result = await this.sock!.sendMessage(jid, { text });

    // ── PRESENCE: 'paused' update intentionally NOT sent ──────────────────
    // ─────────────────────────────────────────────────────────────────────

    if (result) {
      await this.persistMessage(result);
    }
    return result;
  }

  /**
   * Sends an image message with an optional caption.
   *
   * PRESENCE NOTE: sendPresenceUpdate() is intentionally NOT called.
   */
  async sendImageMessage(
    jid: string,
    image: Buffer | { url: string },
    caption?: string,
  ): Promise<WAMessage | undefined> {
    this.ensureConnected();

    // ── PRESENCE: composing update intentionally NOT sent ─────────────────
    // ─────────────────────────────────────────────────────────────────────

    const result = await this.sock!.sendMessage(jid, {
      image: image,
      caption: caption ?? '',
    });

    if (result) {
      await this.persistMessage(result);
    }
    return result;
  }

  /**
   * Sends a generic media message (video, audio, document).
   *
   * PRESENCE NOTE: sendPresenceUpdate() is intentionally NOT called.
   */
  async sendMediaMessage(
    jid: string,
    options: {
      type: 'video' | 'audio' | 'document';
      media: Buffer | { url: string };
      caption?: string;
      mimetype?: string;
      fileName?: string;
    },
  ): Promise<WAMessage | undefined> {
    this.ensureConnected();

    // ── PRESENCE: composing/recording update intentionally NOT sent ────────
    // For audio/voice messages, the standard pattern would call
    // sendPresenceUpdate('recording', jid). We skip this entirely.
    // ─────────────────────────────────────────────────────────────────────

    const payload: any = {
      [options.type]: options.media,
      caption: options.caption,
      mimetype: options.mimetype,
      fileName: options.fileName,
    };

    const result = await this.sock!.sendMessage(jid, payload);
    if (result) {
      await this.persistMessage(result);
    }
    return result;
  }

  /**
   * Marks all messages in a chat as read.
   *
   * ⚠️  IMPORTANT: This sends read receipts to the sender.
   * This method is intentionally NOT called automatically — it is only
   * invoked when the Flutter app explicitly calls POST /chats/:jid/read.
   *
   * PRESENCE NOTE: sendPresenceUpdate('available') is intentionally NOT
   * called before or after this operation.
   */
  async markChatAsRead(jid: string): Promise<void> {
    this.ensureConnected();

    const messages = await this.prisma.message.findMany({
      where: {
        chatId: jid,
        fromMe: false,
        NOT: { status: MessageStatus.READ },
      },
      select: { baileysId: true },
    });

    if (messages.length === 0) return;

    const keys = messages.map((m) => ({
      remoteJid: jid,
      id: m.baileysId,
      fromMe: false,
    }));

    // ── PRESENCE: We do NOT call sendPresenceUpdate('available') here ──────
    // ─────────────────────────────────────────────────────────────────────

    await this.sock!.readMessages(keys);

    // Update local DB
    await this.prisma.message.updateMany({
      where: { chatId: jid, fromMe: false },
      data: { status: MessageStatus.READ },
    });

    await this.prisma.chat.update({
      where: { id: jid },
      data: { unreadCount: 0 },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API — Status / QR
  // ─────────────────────────────────────────────────────────────────────────

  getConnectionInfo(): ConnectionInfo {
    if (
      this.connectionInfo.status === 'close' &&
      !this.isShuttingDown &&
      !this.reconnectTimer
    ) {
      void this.connect();
    }
    return { ...this.connectionInfo };
  }

  /**
   * Triggers a logout, clears auth state, and schedules a new QR generation.
   */
  async logout(): Promise<void> {
    if (this.sock) {
      await this.sock.logout();
    }
    this.authStore.clearAuthState();
    this.setConnectionInfo({ status: 'close' });
    // Reconnect to generate a fresh QR code
    setTimeout(() => void this.connect(), 1000);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Formats a JID into a human-readable fallback (last resort when no
   * contact name or pushName is available).
   * Examples:
   *   "94789418306@s.whatsapp.net" → "94789418306"
   *   "120363012345678901@g.us"    → "120363012345678901@g.us" (kept as-is)
   */
  static formatJidFallback(jid: string): string {
    if (isJidGroup(jid)) return jid;
    return jid.replace(/@s\.whatsapp\.net$/, '').replace(/@.*$/, '');
  }

  private setConnectionInfo(info: Partial<ConnectionInfo>): void {
    this.connectionInfo = {
      ...this.connectionInfo,
      ...info,
      updatedAt: new Date().toISOString(),
    };
    this.events.emit('connection.status', this.connectionInfo);
  }

  private ensureConnected(): void {
    if (!this.sock || this.connectionInfo.status !== 'open') {
      throw new Error('WhatsApp is not connected. Check /connection/status.');
    }
  }

  private ensureMediaDir(): void {
    if (!fs.existsSync(this.mediaUploadDir)) {
      fs.mkdirSync(this.mediaUploadDir, { recursive: true });
    }
  }

  /**
   * Converts a raw Baileys QR string to a base64-encoded PNG.
   * Uses the `qrcode` library (installed as a dependency).
   */
  private async qrToBase64(qrString: string): Promise<string> {
    // Dynamic import to avoid circular dependency issues at startup
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const QRCode = require('qrcode') as typeof import('qrcode');
    return QRCode.toDataURL(qrString);
  }

  /**
   * Creates a minimal logger compatible with Baileys' Pino-based interface.
   * Suppresses debug/trace in production.
   */
  private createBaileysLogger(): any {
    const isDebug = this.config.get<string>('nodeEnv') !== 'production';
    return {
      level: isDebug ? 'warn' : 'silent',
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: (data: any, msg?: string) =>
        this.logger.warn(msg ?? JSON.stringify(data)),
      error: (data: any, msg?: string) =>
        this.logger.error(msg ?? JSON.stringify(data)),
      fatal: (data: any, msg?: string) =>
        this.logger.fatal?.(msg ?? JSON.stringify(data)),
      child: () => this.createBaileysLogger(),
    };
  }
}
