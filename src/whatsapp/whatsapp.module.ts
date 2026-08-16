import { Module } from '@nestjs/common';
import { WhatsAppService } from './whatsapp.service';

@Module({
  imports: [
    // EventEmitter is used internally by WhatsAppService to broadcast
    // message.new and connection.status events to the WebSocket gateway.
    // It is registered globally in AppModule, so we just import here for clarity.
  ],
  providers: [WhatsAppService],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}
