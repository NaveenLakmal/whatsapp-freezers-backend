import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import type { Response } from 'express';
import * as fs from 'fs';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { MediaService } from './media.service';

/**
 * MediaController — serves locally stored WhatsApp media files.
 *
 * All endpoints are protected by ApiKeyGuard to prevent unauthorized
 * access to private media (images, voice notes, documents).
 *
 * PRESENCE NOTE: Serving media files does NOT trigger any WhatsApp
 * presence updates. This is purely local file serving.
 */
@Controller('media')
@UseGuards(ApiKeyGuard)
export class MediaController {
  constructor(private readonly media: MediaService) {}

  /**
   * GET /media/:filename
   *
   * Streams a stored media file to the client with the correct Content-Type.
   * The Flutter app can use this URL to display images, play audio, etc.
   *
   * The filename is the UUID-based name stored in the Message.mediaLocalPath field.
   * Example: GET /media/550e8400-e29b-41d4-a716-446655440000.jpg
   */
  @Get(':filename')
  async serveMedia(
    @Param('filename') filename: string,
    @Res() res: Response,
  ): Promise<void> {
    const { filePath, mimetype, originalName } =
      await this.media.resolveMediaFile(filename);

    res.setHeader('Content-Type', mimetype);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${originalName ?? filename}"`,
    );
    res.setHeader('Cache-Control', 'private, max-age=86400'); // 1 day client cache

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  }

  /**
   * GET /media?limit=50&offset=0
   * Lists stored media file metadata (no binary content).
   * Useful for building a Flutter media gallery.
   */
  @Get()
  listMedia(
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    return this.media.listMediaFiles(limit, offset);
  }
}
