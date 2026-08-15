import { Module } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';
import { WsApiKeyGuard } from './ws-auth.guard';

@Module({
  providers: [ApiKeyGuard, WsApiKeyGuard],
  exports: [ApiKeyGuard, WsApiKeyGuard],
})
export class AuthModule {}
