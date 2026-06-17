import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import type { AuthenticatedUser, AuthRequest } from './auth.types';

export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const user = request.currentUser;

    if (data !== undefined) {
      return user?.[data];
    }

    return user;
  }
);
