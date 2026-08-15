import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import * as fs from 'fs';
import * as path from 'path';

/**
 * MediaService — manages locally stored media files downloaded from WhatsApp.
 *
 * Media files are downloaded by WhatsAppService when incoming messages arrive.
 * This service provides lookup and streaming support for the REST endpoint.
 *
 * PRESENCE NOTE: Accessing/serving media files does NOT trigger any
 * WhatsApp presence updates. Media is served from local disk only.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private readonly uploadDir: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.uploadDir = this.config.get<string>('media.uploadDir') ?? './uploads';
    this.ensureUploadDir();
  }

  /**
   * Resolves the absolute local path for a stored media file by filename.
   * Throws NotFoundException if the file doesn't exist in DB or on disk.
   */
  async resolveMediaFile(filename: string): Promise<{
    filePath: string;
    mimetype: string;
    originalName: string | null;
  }> {
    // Sanitize filename to prevent directory traversal attacks
    const safeFilename = path.basename(filename);

    const record = await this.prisma.mediaFile.findUnique({
      where: { filename: safeFilename },
    });

    if (!record) {
      throw new NotFoundException(`Media file not found: ${safeFilename}`);
    }

    if (!fs.existsSync(record.localPath)) {
      this.logger.error(`Media file missing from disk: ${record.localPath}`);
      throw new NotFoundException(`Media file not available: ${safeFilename}`);
    }

    return {
      filePath: record.localPath,
      mimetype: record.mimetype,
      originalName: record.originalName,
    };
  }

  /**
   * Returns a list of all stored media files (metadata only, no content).
   * Useful for debugging or building a media gallery in the Flutter app.
   */
  async listMediaFiles(limit = 50, offset = 0) {
    return this.prisma.mediaFile.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      select: {
        id: true,
        filename: true,
        originalName: true,
        mimetype: true,
        size: true,
        createdAt: true,
      },
    });
  }

  private ensureUploadDir(): void {
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
      this.logger.log(`Created media upload directory: ${this.uploadDir}`);
    }
  }
}
