import { IsOptional, IsString, IsIn } from 'class-validator';

/**
 * DTO for POST /chats/:jid/messages
 * Supports text and URL-based media messages initially.
 */
export class SendMessageDto {
  /**
   * Plain text content (required when type is 'text').
   * For media messages, this is used as the caption.
   */
  @IsOptional()
  @IsString()
  text?: string;

  /**
   * Message type — defaults to 'text' if not specified.
   */
  @IsOptional()
  @IsIn(['text', 'image', 'video', 'audio', 'document'])
  type?: 'text' | 'image' | 'video' | 'audio' | 'document';

  /**
   * Public URL for media messages (image, video, audio, document).
   * Required when type is not 'text'.
   */
  @IsOptional()
  @IsString()
  mediaUrl?: string;

  /**
   * Optional filename override (useful for document messages).
   */
  @IsOptional()
  @IsString()
  fileName?: string;

  /**
   * MIME type for media (e.g. 'image/jpeg', 'audio/ogg').
   */
  @IsOptional()
  @IsString()
  mimetype?: string;
}
