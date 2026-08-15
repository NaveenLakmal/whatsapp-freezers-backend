import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { ChatsService } from './chats.service';
import { SendMessageDto } from './dto/send-message.dto';
import { PaginationDto } from './dto/pagination.dto';

/**
 * ChatsController — REST endpoints for chat and message operations.
 * All routes are protected by the ApiKeyGuard (x-api-key header).
 */
@Controller('chats')
@UseGuards(ApiKeyGuard)
export class ChatsController {
  constructor(private readonly chats: ChatsService) {}

  /**
   * GET /chats
   * Returns all known conversations, sorted newest-first.
   */
  @Get()
  getChats() {
    return this.chats.getChats();
  }

  /**
   * GET /chats/:jid/messages?limit=50&offset=0
   * Returns paginated message history for a specific chat.
   */
  @Get(':jid/messages')
  getMessages(@Param('jid') jid: string, @Query() pagination: PaginationDto) {
    return this.chats.getMessages(jid, pagination);
  }

  /**
   * POST /chats/:jid/messages
   * Sends a text or media message to the specified JID.
   *
   * Body: { type?: 'text'|'image'|'video'|'audio'|'document', text?, mediaUrl?, ... }
   */
  @Post(':jid/messages')
  @HttpCode(HttpStatus.CREATED)
  sendMessage(@Param('jid') jid: string, @Body() dto: SendMessageDto) {
    return this.chats.sendMessage(jid, dto);
  }

  /**
   * POST /chats/:jid/read
   *
   * EXPLICIT opt-in read receipt. Marks all messages in the chat as read.
   *
   * ⚠️  PRESENCE NOTE: This is the ONLY place read receipts can be triggered.
   * This endpoint must be called deliberately by the Flutter app. It is
   * NEVER called automatically. Calling this WILL notify the sender that
   * you have read their messages.
   */
  @Post(':jid/read')
  @HttpCode(HttpStatus.OK)
  markAsRead(@Param('jid') jid: string) {
    return this.chats.markAsRead(jid);
  }
}
