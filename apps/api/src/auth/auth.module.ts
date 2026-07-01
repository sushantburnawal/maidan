import { Module } from '@nestjs/common';

import { RedisModule } from '../redis/redis.module';
import { AuthController } from './auth.controller';
import { AUTH_REDIS_STORE, PROFILES_REPOSITORY, SMS_PROVIDER } from './auth.constants';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';
import { PostgresProfilesRepository } from './profiles.repository';
import { IoredisAuthStore } from './redis-auth-store';
import { FakeSmsProvider, getMsg91AuthKey, Msg91SmsProvider } from './sms.provider';

@Module({
  imports: [RedisModule],
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
    },
    OptionalJwtAuthGuard
  ],
  exports: [AuthService, JwtAuthGuard, OptionalJwtAuthGuard]
})
export class AuthModule {}
