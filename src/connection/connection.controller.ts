import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { ConnectionService } from './connection.service';

/**
 * ConnectionController — REST endpoints for WhatsApp connection management.
 * All routes are protected by the ApiKeyGuard (x-api-key header).
 */
@Controller('connection')
@UseGuards(ApiKeyGuard)
export class ConnectionController {
  constructor(private readonly connection: ConnectionService) {}

  /**
   * GET /connection/status
   * Returns the current WhatsApp connection state.
   * Possible status values: 'connecting' | 'open' | 'close' | 'qr'
   *
   * Example response:
   *   { "status": "open", "updatedAt": "2024-01-01T10:00:00.000Z" }
   */
  @Get('status')
  getStatus() {
    return this.connection.getStatus();
  }

  /**
   * GET /connection/qr
   * Returns the current QR code as a base64 PNG data URL when not authenticated.
   */
  @Get('qr')
  getQR() {
    return this.connection.getQR();
  }

  /**
   * GET /connection/qr-view
   * Renders a browser-friendly webpage with the QR code and auto-refresh.
   */
  @Get('qr-view')
  getQRView() {
    const { status, qr } = this.connection.getQR();
    if (status === 'open') {
      return `
        <!DOCTYPE html>
        <html>
        <head>
          <title>WhatsApp Connected</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0b141a; color: #e9edef; }
            .card { background: #111b21; padding: 40px; border-radius: 16px; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.5); max-width: 400px; width: 90%; }
            .badge { background: #00a884; color: #fff; padding: 8px 16px; border-radius: 20px; font-weight: bold; display: inline-block; margin-bottom: 20px; }
            h1 { font-size: 24px; margin-bottom: 10px; }
            p { color: #8696a0; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="badge">Connected</div>
            <h1>WhatsApp is Linked</h1>
            <p>Your session is active and ready to send & receive messages.</p>
          </div>
        </body>
        </html>
      `;
    }

    if (qr) {
      return `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Scan WhatsApp QR Code</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <meta http-equiv="refresh" content="15">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0b141a; color: #e9edef; }
            .card { background: #111b21; padding: 30px; border-radius: 16px; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.5); max-width: 400px; width: 90%; }
            img { width: 260px; height: 260px; border-radius: 8px; background: white; padding: 10px; margin: 20px 0; }
            h1 { font-size: 20px; margin: 0; }
            ol { text-align: left; color: #8696a0; font-size: 13px; line-height: 1.6; padding-left: 20px; }
            .refresh-tip { font-size: 12px; color: #00a884; margin-top: 15px; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Link WhatsApp</h1>
            <img src="${qr}" alt="WhatsApp QR Code" />
            <ol>
              <li>Open WhatsApp on your phone</li>
              <li>Tap <b>Settings</b> &gt; <b>Linked Devices</b></li>
              <li>Tap <b>Link a Device</b> and point camera here</li>
            </ol>
            <div class="refresh-tip">&#8635; Auto-refreshes every 15s</div>
          </div>
        </body>
        </html>
      `;
    }

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Connecting WhatsApp...</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="refresh" content="3">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0b141a; color: #e9edef; }
          .card { background: #111b21; padding: 30px; border-radius: 16px; text-align: center; max-width: 400px; }
          p { color: #8696a0; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>Generating QR Code...</h2>
          <p>Status: ${status}. Reloading shortly...</p>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * DELETE /connection/logout
   * Logs out from WhatsApp and clears the stored session.
   * After calling this, re-scan the QR at GET /connection/qr to reconnect.
   */
  @Delete('logout')
  @HttpCode(HttpStatus.OK)
  logout() {
    return this.connection.logout();
  }
}
