import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

import { AuthService } from './auth.service';
import type { AuthRequest } from './auth.types';

@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const token = extractOptionalBearerToken(request.headers.authorization);

    if (token !== undefined) {
      request.currentUser = this.authService.authenticateAccessToken(token);
    }

    return true;
  }
}

function extractOptionalBearerToken(
  authorization: string | string[] | undefined
): string | undefined {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;

  if (header === undefined) {
    return undefined;
  }

  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || token === undefined || token.length === 0) {
    throw new UnauthorizedException('Invalid bearer token');
  }

  return token;
}
