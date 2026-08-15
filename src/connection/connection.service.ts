import { Injectable } from '@nestjs/common';
import { WhatsAppService, ConnectionInfo } from '../whatsapp/whatsapp.service';

/**
 * ConnectionService — thin delegation layer between the connection
 * controller and WhatsAppService. Keeps the controller clean.
 */
@Injectable()
export class ConnectionService {
  constructor(private readonly whatsapp: WhatsAppService) {}

  getStatus(): ConnectionInfo {
    return this.whatsapp.getConnectionInfo();
  }

  /**
   * Returns the current QR code as a base64 data URL (image/png).
   * Returns null if the connection is already authenticated.
   */
  getQR(): { qr: string | null; status: string } {
    const info = this.whatsapp.getConnectionInfo();
    return {
      status: info.status,
      qr: info.status === 'qr' ? (info.qr ?? null) : null,
    };
  }

  /**
   * Logs out from WhatsApp, clears the auth state, and triggers a new QR.
   * The Flutter app must re-scan the QR to reconnect.
   */
  async logout(): Promise<{ success: boolean; message: string }> {
    await this.whatsapp.logout();
    return {
      success: true,
      message: 'Logged out. Scan the QR at GET /connection/qr to reconnect.',
    };
  }
}
