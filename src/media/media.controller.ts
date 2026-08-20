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
 * GET /media/:filename is intentionally NOT behind ApiKeyGuard.
 * Reason: Flutter's image widgets (CachedNetworkImage, Image.network) do not
 * support custom HTTP headers, so they cannot send the x-api-key header.
 * Media filenames are UUIDs (e.g. 550e8400-e29b-41d4-a716-446655440000.jpg)
 * which are cryptographically unguessable, providing sufficient security for
 * a local-network deployment.
 *
 * GET /media (listing) DOES require the API key since it enumerates filenames.
 *
 * PRESENCE NOTE: Serving media files does NOT trigger any WhatsApp
 * presence updates. Media is served from local disk only.
 */
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  /**
   * GET /media/:filename
   *
   * Streams a stored media file to the client with the correct Content-Type.
   * The Flutter app can use this URL to display images, play audio, etc.
   *
   * No API key required — filenames are UUIDs (unguessable).
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
    // Allow public caching since filenames are UUIDs and content never changes
    res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 day

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  }

  /**
   * GET /media?limit=50&offset=0
   * Lists stored media file metadata (no binary content).
   * Requires API key since it enumerates filenames.
   */
  @Get()
  @UseGuards(ApiKeyGuard)
  listMedia(
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    return this.media.listMediaFiles(limit, offset);
  }
}
