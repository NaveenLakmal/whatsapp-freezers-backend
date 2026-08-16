import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): { status: string; service: string } {
    return {
      status: 'ok',
      service: 'whatsapp-chat-backend',
    };
  }

  @Get('health')
  getHealth(): { status: string } {
    return {
      status: 'ok',
    };
  }
}
