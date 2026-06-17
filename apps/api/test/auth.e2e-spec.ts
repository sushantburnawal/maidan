import { Controller, Get, UseGuards, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import { AuthModule } from '../src/auth/auth.module';
import { AUTH_REDIS_STORE, PROFILES_REPOSITORY, SMS_PROVIDER } from '../src/auth/auth.constants';
import { CurrentUser } from '../src/auth/current-user.decorator';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { FakeSmsProvider } from '../src/auth/sms.provider';
import type { AuthRedisStore, ProfileRecord, ProfilesRepository } from '../src/auth/auth.types';

@Controller('auth-test')
class AuthTestController {
  @Get('protected')
  @UseGuards(JwtAuthGuard)
  getProtected(@CurrentUser('profileId') profileId: string): { profileId: string } {
    return { profileId };
  }
}

interface RedisEntry {
  value: string;
  expiresAtMs?: number;
}

class FakeRedisStore implements AuthRedisStore {
  private readonly entries = new Map<string, RedisEntry>();

  async get(key: string): Promise<string | null> {
    return this.getEntry(key)?.value ?? null;
  }

  async setEx(key: string, seconds: number, value: string): Promise<void> {
    this.entries.set(key, {
      value,
      expiresAtMs: Date.now() + seconds * 1000
    });
  }

  async setPx(key: string, milliseconds: number, value: string): Promise<void> {
    this.entries.set(key, {
      value,
      expiresAtMs: Date.now() + milliseconds
    });
  }

  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async incr(key: string): Promise<number> {
    const entry = this.getEntry(key);
    const nextValue = entry === undefined ? 1 : Number(entry.value) + 1;

    this.entries.set(key, {
      value: String(nextValue),
      expiresAtMs: entry?.expiresAtMs
    });

    return nextValue;
  }

  async expire(key: string, seconds: number): Promise<void> {
    const entry = this.getEntry(key);

    if (entry !== undefined) {
      entry.expiresAtMs = Date.now() + seconds * 1000;
    }
  }

  async pttl(key: string): Promise<number> {
    const entry = this.getEntry(key);

    if (entry === undefined) {
      return -2;
    }

    if (entry.expiresAtMs === undefined) {
      return -1;
    }

    return Math.max(0, entry.expiresAtMs - Date.now());
  }

  private getEntry(key: string): RedisEntry | undefined {
    const entry = this.entries.get(key);

    if (entry === undefined) {
      return undefined;
    }

    if (entry.expiresAtMs !== undefined && entry.expiresAtMs <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }

    return entry;
  }
}

class FakeProfilesRepository implements ProfilesRepository {
  private readonly profilesByPhone = new Map<string, ProfileRecord>();

  async findOrCreateByPhone(phone: string): Promise<ProfileRecord> {
    const existingProfile = this.profilesByPhone.get(phone);

    if (existingProfile !== undefined) {
      return existingProfile;
    }

    const profile = {
      id: randomUUID(),
      phone
    };

    this.profilesByPhone.set(phone, profile);

    return profile;
  }

  getProfile(phone: string): ProfileRecord | undefined {
    return this.profilesByPhone.get(phone);
  }
}

describe('Auth OTP flow', () => {
  let app: NestFastifyApplication;
  let smsProvider: FakeSmsProvider;
  let profilesRepository: FakeProfilesRepository;

  const originalAccessSecret = process.env.JWT_ACCESS_SECRET;
  const originalRefreshSecret = process.env.JWT_REFRESH_SECRET;
  const originalAccessTtl = process.env.JWT_ACCESS_TTL;
  const originalRefreshTtl = process.env.JWT_REFRESH_TTL;
  const phone = '+919900000999';

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET = 'test-access-secret';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
    process.env.JWT_ACCESS_TTL = '15m';
    process.env.JWT_REFRESH_TTL = '30d';

    smsProvider = new FakeSmsProvider();
    profilesRepository = new FakeProfilesRepository();

    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule],
      controllers: [AuthTestController]
    })
      .overrideProvider(AUTH_REDIS_STORE)
      .useValue(new FakeRedisStore())
      .overrideProvider(SMS_PROVIDER)
      .useValue(smsProvider)
      .overrideProvider(PROFILES_REPOSITORY)
      .useValue(profilesRepository)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(
      new ValidationPipe({
        forbidNonWhitelisted: true,
        transform: true,
        whitelist: true
      })
    );

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    restoreEnv('JWT_ACCESS_SECRET', originalAccessSecret);
    restoreEnv('JWT_REFRESH_SECRET', originalRefreshSecret);
    restoreEnv('JWT_ACCESS_TTL', originalAccessTtl);
    restoreEnv('JWT_REFRESH_TTL', originalRefreshTtl);

    await app.close();
  });

  it('requests, verifies, authorizes, rotates, and rejects the old refresh token', async () => {
    const requestOtpResponse = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      payload: { phone }
    });

    expect(requestOtpResponse.statusCode).toBe(200);
    expect(requestOtpResponse.json()).toEqual({
      ok: true,
      expiresInSeconds: 120
    });

    const otp = smsProvider.getLastOtp(phone);
    expect(otp).toMatch(/^[0-9]{6}$/);

    if (otp === undefined) {
      throw new Error('Fake SMS provider did not capture an OTP');
    }

    const verifyResponse = await app.inject({
      method: 'POST',
      url: '/auth/verify-otp',
      payload: { phone, code: otp }
    });

    expect(verifyResponse.statusCode).toBe(200);
    expect(verifyResponse.body).not.toContain(otp);

    const tokens = verifyResponse.json() as {
      accessToken: string;
      refreshToken: string;
      tokenType: string;
      expiresInSeconds: number;
    };
    expect(tokens.tokenType).toBe('Bearer');
    expect(tokens.expiresInSeconds).toBe(15 * 60);

    const profile = profilesRepository.getProfile(phone);
    expect(profile).toBeDefined();

    if (profile === undefined) {
      throw new Error('Fake profiles repository did not create a profile');
    }

    const protectedResponse = await app.inject({
      method: 'GET',
      url: '/auth-test/protected',
      headers: {
        authorization: `Bearer ${tokens.accessToken}`
      }
    });

    expect(protectedResponse.statusCode).toBe(200);
    expect(protectedResponse.json()).toEqual({
      profileId: profile.id
    });

    const refreshResponse = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: {
        refreshToken: tokens.refreshToken
      }
    });

    expect(refreshResponse.statusCode).toBe(200);
    expect(refreshResponse.body).not.toContain(otp);

    const rotatedTokens = refreshResponse.json() as {
      accessToken: string;
      refreshToken: string;
      tokenType: string;
      expiresInSeconds: number;
    };
    expect(rotatedTokens.refreshToken).not.toBe(tokens.refreshToken);

    const oldRefreshResponse = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: {
        refreshToken: tokens.refreshToken
      }
    });

    expect(oldRefreshResponse.statusCode).toBe(401);
    expect(oldRefreshResponse.body).not.toContain(otp);
    expect(requestOtpResponse.body).not.toContain(otp);
    expect(protectedResponse.body).not.toContain(otp);
  });
});

function restoreEnv(name: string, originalValue: string | undefined): void {
  if (originalValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = originalValue;
  }
}
