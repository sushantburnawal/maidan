import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller';
import { AUTH_REDIS_STORE, PROFILES_REPOSITORY, SMS_PROVIDER } from './auth.constants';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PostgresProfilesRepository } from './profiles.repository';
import { IoredisAuthStore } from './redis-auth-store';
import { FakeSmsProvider, getMsg91AuthKey, Msg91SmsProvider } from './sms.provider';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtAuthGuard,
    {
      provide: AUTH_REDIS_STORE,
      useClass: IoredisAuthStore
    },
    {
      provide: PROFILES_REPOSITORY,
      useClass: PostgresProfilesRepository
    },
    {
      provide: SMS_PROVIDER,
      useFactory: () =>
        getMsg91AuthKey() === undefined ? new FakeSmsProvider() : new Msg91SmsProvider()
    }
  ],
  exports: [AuthService, JwtAuthGuard]
})
export class AuthModule {}
