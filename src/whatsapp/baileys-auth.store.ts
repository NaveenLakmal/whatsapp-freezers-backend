import * as fs from 'fs';
import * as path from 'path';
import {
  useMultiFileAuthState,
  AuthenticationState,
} from '@whiskeysockets/baileys';
import { Logger } from '@nestjs/common';

/**
 * BaileysAuthStore
 *
 * Thin wrapper around Baileys' built-in `useMultiFileAuthState` helper.
 * Credentials (auth keys, session tokens) are stored as JSON files in
 * AUTH_STATE_DIR so they survive server restarts.
 *
 * To switch to a database-backed auth store in the future:
 *  - Replace the return value of `getAuthState()` with a custom implementation
 *    of AuthenticationState that reads/writes to your DB.
 *  - The rest of the codebase requires no changes.
 */
export class BaileysAuthStore {
  private readonly logger = new Logger(BaileysAuthStore.name);
  private authDir: string;

  constructor(authDir: string) {
    this.authDir = authDir;
    this.ensureAuthDir();
  }

  /**
   * Ensures the auth state directory exists, creating it if necessary.
   */
  private ensureAuthDir(): void {
    if (!fs.existsSync(this.authDir)) {
      fs.mkdirSync(this.authDir, { recursive: true });
      this.logger.log(`Created auth state directory: ${this.authDir}`);
    }
  }

  /**
   * Returns the Baileys auth state and a saveCreds callback.
   * Call saveCreds() whenever the 'creds.update' event fires.
   */
  async getAuthState(): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
  }> {
    const absPath = path.resolve(this.authDir);
    this.logger.log(`Loading auth state from: ${absPath}`);
    return useMultiFileAuthState(absPath);
  }

  /**
   * Clears the auth state — used when logging out.
   * After calling this, the server will require a new QR scan.
   */
  clearAuthState(): void {
    if (fs.existsSync(this.authDir)) {
      const files = fs.readdirSync(this.authDir);
      for (const file of files) {
        fs.unlinkSync(path.join(this.authDir, file));
      }
      this.logger.warn(`Auth state cleared from: ${this.authDir}`);
    }
  }

  /**
   * Returns true if credentials already exist (i.e. QR scan already done).
   */
  hasCredentials(): boolean {
    const credsFile = path.join(this.authDir, 'creds.json');
    return fs.existsSync(credsFile);
  }
}
