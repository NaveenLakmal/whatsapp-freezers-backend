import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger, UseGuards } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { OnEvent } from '@nestjs/event-emitter';
import { WsApiKeyGuard } from '../auth/ws-auth.guard';
import { ConfigService } from '@nestjs/config';
import type { ConnectionInfo } from '../whatsapp/whatsapp.service';

/**
 * EventsGateway — Socket.io WebSocket gateway.
 *
 * Provides real-time push notifications to the Flutter app for:
 *   - 'message.new'       : New incoming or outgoing message
 *   - 'connection.status' : WhatsApp connection state changes (open/close/qr)
 *   - 'message.status'    : Delivery/read status updates for sent messages
 *
 * Authentication:
 *   Flutter clients must authenticate during the Socket.io handshake:
 *     Option A (recommended):
 *       io(url, { auth: { apiKey: 'your-api-key' } })
 *     Option B (fallback):
 *       io(url, { query: { apiKey: 'your-api-key' } })
 *
 * CORS is configured in main.ts — update the origin list for production.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PRESENCE POLICY
 * ─────────────────────────────────────────────────────────────────────────────
 * This gateway does NOT trigger any WhatsApp presence updates.
 * Receiving a WebSocket event does NOT cause sendPresenceUpdate() to be called.
 * The gateway is read-only from WhatsApp's perspective.
 * ─────────────────────────────────────────────────────────────────────────────
 */
@WebSocketGateway({
  cors: {
    origin: '*', // Restrict to your Flutter app's origin in production
    credentials: true,
  },
  namespace: '/',
})
export class EventsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EventsGateway.name);

  constructor(
    private readonly config: ConfigService,
    private readonly wsGuard: WsApiKeyGuard,
  ) {}

  afterInit(): void {
    this.logger.log('WebSocket gateway initialized.');
  }

  /**
   * Validates the API key on every new Socket.io connection.
   * Disconnects the client immediately if the key is missing or invalid.
   */
  handleConnection(client: Socket): void {
    const expected = this.config.get<string>('apiKey');
    const key =
      (client.handshake.auth as Record<string, string>)?.apiKey ??
      (client.handshake.query?.apiKey as string | undefined);

    if (!key || key !== expected) {
      this.logger.warn(
        `WS rejected: invalid API key from ${client.handshake.address} [id=${client.id}]`,
      );
      client.emit('error', { message: 'Unauthorized: invalid API key.' });
      client.disconnect(true);
      return;
    }

    this.logger.log(`WS client connected: ${client.id} from ${client.handshake.address}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`WS client disconnected: ${client.id}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal Event Listeners (from EventEmitter2 / WhatsAppService)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Broadcasts a new message to all connected Flutter clients.
   * Fired by WhatsAppService when 'messages.upsert' is received from Baileys.
   *
   * Payload shape:
   * {
   *   id, baileysId, chatId, remoteJid, fromMe,
   *   messageType, body, mediaUrl, mediaLocalPath,
   *   mimetype, fileName, timestamp, status
   * }
   */
  @OnEvent('message.new')
  handleNewMessage(payload: Record<string, unknown>): void {
    // NOTE: We do NOT log message body/content here to protect privacy in logs
    this.logger.log(`Emitting message.new [chatId=${payload['chatId']}]`);
    this.server.emit('message.new', payload);
  }

  /**
   * Broadcasts WhatsApp connection status changes to all Flutter clients.
   * Fired by WhatsAppService on connection.update events from Baileys.
   *
   * Payload shape:
   * {
   *   status: 'connecting' | 'open' | 'close' | 'qr',
   *   qr?: string,   // base64 data URL, only present when status === 'qr'
   *   updatedAt: string
   * }
   */
  @OnEvent('connection.status')
  handleConnectionStatus(payload: ConnectionInfo): void {
    this.logger.log(`Emitting connection.status: ${payload.status}`);
    this.server.emit('connection.status', payload);
  }

  /**
   * Broadcasts message delivery/read status updates to Flutter clients.
   * Fired by WhatsAppService when 'messages.update' events arrive from Baileys.
   *
   * Payload shape:
   * { baileysId: string, status: 'DELIVERED' | 'READ' | 'FAILED' }
   */
  @OnEvent('message.status')
  handleMessageStatus(payload: Record<string, unknown>): void {
    this.server.emit('message.status', payload);
  }
}
