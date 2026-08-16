import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';

/**
 * WsApiKeyGuard — protects WebSocket gateway connections.
 *
 * Flutter clients must authenticate during the Socket.io handshake:
 *   Option A (recommended): Pass in the auth object:
 *     socket = io(url, { auth: { apiKey: '<key>' } });
 *   Option B: Pass as query param:
 *     socket = io(url, { query: { apiKey: '<key>' } });
 */
@Injectable()
export class WsApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(WsApiKeyGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const client = context.switchToWs().getClient<Socket>();
    const expected = this.config.get<string>('apiKey');

    if (!expected) {
      throw new WsException('Server API key is not configured.');
    }

    // Accept key from Socket.io auth object or query param
    const key =
      (client.handshake.auth as Record<string, string>)?.apiKey ??
      (client.handshake.query?.apiKey as string | undefined);

    if (!key || key !== expected) {
      this.logger.warn(
        `WebSocket connection rejected — invalid API key from ${client.handshake.address}`,
      );
      throw new WsException('Invalid or missing API key.');
    }

    return true;
  }
}
