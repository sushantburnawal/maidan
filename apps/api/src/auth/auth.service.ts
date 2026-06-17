import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException
} from '@nestjs/common';
import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';

import {
  AUTH_REDIS_STORE,
  DEFAULT_ACCESS_TOKEN_TTL,
  DEFAULT_REFRESH_TOKEN_TTL,
  OTP_MAX_VERIFY_ATTEMPTS,
  OTP_RATE_LIMIT_MAX_REQUESTS,
  OTP_RATE_LIMIT_WINDOW_SECONDS,
  OTP_TTL_SECONDS,
  PROFILES_REPOSITORY,
  SMS_PROVIDER
} from './auth.constants';
import type {
  AuthRedisStore,
  AuthenticatedUser,
  AuthTokens,
  ProfilesRepository,
  SmsProvider
} from './auth.types';

interface OtpState {
  code: string;
  attempts: number;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(AUTH_REDIS_STORE) private readonly redis: AuthRedisStore,
    @Inject(SMS_PROVIDER) private readonly smsProvider: SmsProvider,
    @Inject(PROFILES_REPOSITORY) private readonly profilesRepository: ProfilesRepository
  ) {}

  async requestOtp(phone: string): Promise<{ ok: true; expiresInSeconds: number }> {
    await this.checkOtpRateLimit(phone);

    const key = otpKey(phone);
    const code = generateOtp();
    const state: OtpState = { code, attempts: 0 };

    await this.redis.setEx(key, OTP_TTL_SECONDS, JSON.stringify(state));

    try {
      await this.smsProvider.sendOtp(phone, code);
    } catch (error) {
      await this.redis.del(key);
      throw error;
    }

    return {
      ok: true,
      expiresInSeconds: OTP_TTL_SECONDS
    };
  }

  async verifyOtp(phone: string, code: string): Promise<AuthTokens> {
    const key = otpKey(phone);
    const state = parseOtpState(await this.redis.get(key));

    if (state === undefined) {
      await this.redis.del(key);
      throw invalidOtp();
    }

    if (state.code !== code) {
      await this.recordFailedOtpAttempt(key, state);
      throw invalidOtp();
    }

    await this.redis.del(key);
    const profile = await this.profilesRepository.findOrCreateByPhone(phone);

    return this.issueTokens(profile.id);
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    const payload = verifyRefreshJwt(refreshToken);
    const profileId = getJwtSubject(payload, invalidRefreshToken);
    const refreshTokenId = getJwtId(payload);
    const key = refreshTokenKey(profileId, refreshTokenId);
    const storedTokenHash = await this.redis.get(key);

    if (storedTokenHash === null || !tokenHashesEqual(storedTokenHash, hashToken(refreshToken))) {
      throw invalidRefreshToken();
    }

    await this.redis.del(key);

    return this.issueTokens(profileId);
  }

  authenticateAccessToken(accessToken: string): AuthenticatedUser {
    const payload = verifyAccessJwt(accessToken);
    const profileId = getJwtSubject(payload, invalidAccessToken);

    return { profileId };
  }

  private async checkOtpRateLimit(phone: string): Promise<void> {
    const key = otpRateLimitKey(phone);
    const requestCount = await this.redis.incr(key);

    if (requestCount === 1) {
      await this.redis.expire(key, OTP_RATE_LIMIT_WINDOW_SECONDS);
    }

    if (requestCount > OTP_RATE_LIMIT_MAX_REQUESTS) {
      throw new HttpException('Too many OTP requests', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private async recordFailedOtpAttempt(key: string, state: OtpState): Promise<void> {
    const nextState: OtpState = {
      code: state.code,
      attempts: state.attempts + 1
    };

    if (nextState.attempts >= OTP_MAX_VERIFY_ATTEMPTS) {
      await this.redis.del(key);
      return;
    }

    const ttlMs = await this.redis.pttl(key);

    if (ttlMs > 0) {
      await this.redis.setPx(key, ttlMs, JSON.stringify(nextState));
    } else {
      await this.redis.del(key);
    }
  }

  private async issueTokens(profileId: string): Promise<AuthTokens> {
    const accessTtl = process.env.JWT_ACCESS_TTL ?? DEFAULT_ACCESS_TOKEN_TTL;
    const refreshTtl = process.env.JWT_REFRESH_TTL ?? DEFAULT_REFRESH_TOKEN_TTL;
    const refreshTokenId = randomUUID();
    const accessToken = signToken({ typ: 'access' }, accessSecret(), accessTtl, profileId);
    const refreshToken = signToken(
      { typ: 'refresh' },
      refreshSecret(),
      refreshTtl,
      profileId,
      refreshTokenId
    );

    await this.redis.setEx(
      refreshTokenKey(profileId, refreshTokenId),
      parseDurationSeconds(refreshTtl),
      hashToken(refreshToken)
    );

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresInSeconds: parseDurationSeconds(accessTtl)
    };
  }
}

function otpKey(phone: string): string {
  return `otp:${phone}`;
}

function otpRateLimitKey(phone: string): string {
  return `otp-rate:${phone}`;
}

function refreshTokenKey(profileId: string, refreshTokenId: string): string {
  return `refresh:${profileId}:${refreshTokenId}`;
}

function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function parseOtpState(value: string | null): OtpState | undefined {
  if (value === null) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(value);

    if (isOtpState(parsed)) {
      return parsed;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function isOtpState(value: unknown): value is OtpState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const maybeState = value as Partial<OtpState>;

  return (
    typeof maybeState.code === 'string' &&
    /^[0-9]{6}$/.test(maybeState.code) &&
    typeof maybeState.attempts === 'number' &&
    Number.isInteger(maybeState.attempts) &&
    maybeState.attempts >= 0
  );
}

function signToken(
  payload: { typ: 'access' | 'refresh' },
  secret: string,
  expiresIn: string,
  subject: string,
  jwtid?: string
): string {
  const options: SignOptions = {
    subject,
    expiresIn: expiresIn as SignOptions['expiresIn']
  };

  if (jwtid !== undefined) {
    options.jwtid = jwtid;
  }

  return jwt.sign(payload, secret, options);
}

function verifyAccessJwt(token: string): JwtPayload {
  const payload = verifyJwt(token, accessSecret(), invalidAccessToken);

  if (payload.typ !== 'access') {
    throw invalidAccessToken();
  }

  return payload;
}

function verifyRefreshJwt(token: string): JwtPayload {
  const payload = verifyJwt(token, refreshSecret(), invalidRefreshToken);

  if (payload.typ !== 'refresh') {
    throw invalidRefreshToken();
  }

  return payload;
}

function verifyJwt(
  token: string,
  secret: string,
  invalidToken: () => UnauthorizedException
): JwtPayload {
  try {
    const payload = jwt.verify(token, secret);

    if (typeof payload === 'string') {
      throw invalidToken();
    }

    return payload;
  } catch {
    throw invalidToken();
  }
}

function getJwtSubject(payload: JwtPayload, invalidToken: () => UnauthorizedException): string {
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw invalidToken();
  }

  return payload.sub;
}

function getJwtId(payload: JwtPayload): string {
  if (typeof payload.jti !== 'string' || payload.jti.length === 0) {
    throw invalidRefreshToken();
  }

  return payload.jti;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function tokenHashesEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseDurationSeconds(value: string): number {
  const match = /^(\d+)([smhd])?$/.exec(value.trim());

  if (match === null) {
    throw new InternalServerErrorException(`Invalid JWT duration: ${value}`);
  }

  const amountText = match[1];
  const unit = match[2] ?? 's';

  if (amountText === undefined) {
    throw new InternalServerErrorException(`Invalid JWT duration: ${value}`);
  }

  const amount = Number(amountText);
  const multipliers: Record<string, number> = {
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 24 * 60 * 60
  };
  const multiplier = multipliers[unit];

  if (!Number.isSafeInteger(amount) || amount <= 0 || multiplier === undefined) {
    throw new InternalServerErrorException(`Invalid JWT duration: ${value}`);
  }

  return amount * multiplier;
}

function accessSecret(): string {
  return requiredSecret('JWT_ACCESS_SECRET');
}

function refreshSecret(): string {
  return requiredSecret('JWT_REFRESH_SECRET');
}

function requiredSecret(name: 'JWT_ACCESS_SECRET' | 'JWT_REFRESH_SECRET'): string {
  const value = process.env[name];

  if (value === undefined || value.length === 0) {
    throw new InternalServerErrorException(`${name} is not configured`);
  }

  return value;
}

function invalidOtp(): UnauthorizedException {
  return new UnauthorizedException('Invalid or expired OTP');
}

function invalidAccessToken(): UnauthorizedException {
  return new UnauthorizedException('Invalid access token');
}

function invalidRefreshToken(): UnauthorizedException {
  return new UnauthorizedException('Invalid refresh token');
}
