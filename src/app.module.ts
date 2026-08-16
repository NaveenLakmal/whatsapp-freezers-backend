import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';
import { ChatsModule } from './chats/chats.module';
import { ConnectionModule } from './connection/connection.module';
import { EventsModule } from './events/events.module';
import { MediaModule } from './media/media.module';

import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    // ── Config ────────────────────────────────────────────────────────────
    // isGlobal: true makes ConfigService injectable everywhere without
    // importing ConfigModule in each feature module.
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: '.env',
    }),

    // ── Event Emitter ─────────────────────────────────────────────────────
    // Used by WhatsAppService to emit internal events (message.new,
    // connection.status) that the WebSocket gateway listens to.
    EventEmitterModule.forRoot({
      wildcard: false,
      delimiter: '.',
      maxListeners: 20,
      verboseMemoryLeak: true,
    }),

    // ── Database ──────────────────────────────────────────────────────────
    PrismaModule,

    // ── Auth ──────────────────────────────────────────────────────────────
    AuthModule,

    // ── Feature Modules ───────────────────────────────────────────────────
    WhatsAppModule,
    ChatsModule,
    ConnectionModule,
    EventsModule,
    MediaModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
