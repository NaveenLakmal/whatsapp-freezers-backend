import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

/**
 * ApiKeyGuard — protects REST endpoints by checking the x-api-key header.
 *
 * Flutter clients must include this header in every request:
 *   x-api-key: <API_KEY from .env>
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const key =
      request.headers['x-api-key'] ||
      (request.query?.apiKey as string | undefined);
    const expected = this.config.get<string>('apiKey');

    if (!expected) {
      throw new UnauthorizedException('Server API key is not configured.');
    }

    if (!key || key !== expected) {
      throw new UnauthorizedException('Invalid or missing API key.');
    }

    return true;
  }
}
