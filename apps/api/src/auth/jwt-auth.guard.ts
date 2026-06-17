import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

import { AuthService } from './auth.service';
import type { AuthRequest } from './auth.types';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const token = extractBearerToken(request.headers.authorization);

    request.currentUser = this.authService.authenticateAccessToken(token);

    return true;
  }
}

function extractBearerToken(authorization: string | string[] | undefined): string {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;

  if (header === undefined) {
    throw new UnauthorizedException('Missing bearer token');
  }

  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || token === undefined || token.length === 0) {
    throw new UnauthorizedException('Invalid bearer token');
  }

  return token;
}
