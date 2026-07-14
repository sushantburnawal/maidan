import { Controller, Get, UseGuards, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import { AuthModule } from '../src/auth/auth.module';
import {
  AUTH_REDIS_STORE,
  FIREBASE_AUTH_VERIFIER,
  PROFILES_REPOSITORY,
  SMS_PROVIDER
} from '../src/auth/auth.constants';
import { CurrentUser } from '../src/auth/current-user.decorator';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { FakeSmsProvider } from '../src/auth/sms.provider';
import type {
  AuthRedisStore,
  AuthTokens,
  FirebaseAuthToken,
  FirebaseAuthVerifier,
  FirebaseProfileIdentity,
  FirebaseProfileResolution,
  ProfileRecord,
  ProfilesRepository
} from '../src/auth/auth.types';

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
  private readonly profilesByFirebaseUid = new Map<string, FakeFirebaseProfile>();
  private readonly profilesByEmail = new Map<string, FakeFirebaseProfile>();

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

  async resolveFirebaseIdentity(
    identity: FirebaseProfileIdentity
  ): Promise<FirebaseProfileResolution> {
    const normalizedEmail = identity.email.trim().toLowerCase();
    const existingProfileByEmail = this.profilesByEmail.get(normalizedEmail);

    if (existingProfileByEmail !== undefined) {
      if (existingProfileByEmail.firebaseUid === null) {
        existingProfileByEmail.firebaseUid = identity.firebaseUid;
        this.profilesByFirebaseUid.set(identity.firebaseUid, existingProfileByEmail);
      }

      return {
        status: 'found',
        matchedBy: 'email',
        profile: existingProfileByEmail
      };
    }

    const existingProfileByUid = this.profilesByFirebaseUid.get(identity.firebaseUid);

    if (existingProfileByUid !== undefined) {
      return {
        status: 'found',
        matchedBy: 'firebase_uid',
        profile: existingProfileByUid
      };
    }

    if (identity.signupDisplayName === undefined) {
      return {
        status: 'signup_required'
      };
    }

    const profile: FakeFirebaseProfile = {
      id: randomUUID(),
      phone: null,
      firebaseUid: identity.firebaseUid,
      email: normalizedEmail,
      displayName: identity.signupDisplayName,
      avatarUrl: identity.avatarUrl
    };

    this.profilesByFirebaseUid.set(identity.firebaseUid, profile);
    this.profilesByEmail.set(normalizedEmail, profile);

    return {
      status: 'created',
      profile
    };
  }

  getProfile(phone: string): ProfileRecord | undefined {
    return this.profilesByPhone.get(phone);
  }

  addFirebaseProfile(profile: FakeFirebaseProfile): void {
    this.profilesByEmail.set(profile.email.trim().toLowerCase(), profile);

    if (profile.firebaseUid !== null) {
      this.profilesByFirebaseUid.set(profile.firebaseUid, profile);
    }
  }

  getFirebaseProfile(firebaseUid: string): FakeFirebaseProfile | undefined {
    return this.profilesByFirebaseUid.get(firebaseUid);
  }

  getFirebaseProfileByEmail(email: string): FakeFirebaseProfile | undefined {
    return this.profilesByEmail.get(email.trim().toLowerCase());
  }
}

interface FakeFirebaseProfile extends ProfileRecord {
  firebaseUid: string | null;
  email: string;
  displayName: string;
  avatarUrl?: string;
}

class FakeFirebaseAuthVerifier implements FirebaseAuthVerifier {
  private readonly tokens = new Map<string, FirebaseAuthToken>();

  async verifyIdToken(idToken: string): Promise<FirebaseAuthToken> {
    const token = this.tokens.get(idToken);

    if (token === undefined) {
      throw new Error('Invalid Firebase ID token');
    }

    return token;
  }

  setToken(idToken: string, token: FirebaseAuthToken): void {
    this.tokens.set(idToken, token);
  }
}

describe('Auth OTP flow', () => {
  let app: NestFastifyApplication;
  let smsProvider: FakeSmsProvider;
  let profilesRepository: FakeProfilesRepository;
  let firebaseAuthVerifier: FakeFirebaseAuthVerifier;

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
    firebaseAuthVerifier = new FakeFirebaseAuthVerifier();

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
      .overrideProvider(FIREBASE_AUTH_VERIFIER)
      .useValue(firebaseAuthVerifier)
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

  it('requires a name for a new Google user, creates the profile, and reuses it', async () => {
    const idToken = 'valid-google-firebase-id-token';
    const firebaseUid = 'firebase-google-uid-1';

    firebaseAuthVerifier.setToken(idToken, {
      uid: firebaseUid,
      email: 'Asha.Rao@Example.com',
      emailVerified: true,
      displayName: 'Asha Google',
      picture: 'https://example.com/asha.png',
      signInProvider: 'google.com'
    });

    const signupRequiredResponse = await app.inject({
      method: 'POST',
      url: '/auth/firebase/google',
      payload: { idToken }
    });

    expect(signupRequiredResponse.statusCode).toBe(200);
    expect(signupRequiredResponse.body).not.toContain(idToken);
    expect(signupRequiredResponse.json()).toEqual({
      signupRequired: true,
      email: 'asha.rao@example.com',
      suggestedDisplayName: 'Asha Google'
    });
    expect(profilesRepository.getFirebaseProfile(firebaseUid)).toBeUndefined();
    expect(profilesRepository.getFirebaseProfileByEmail('asha.rao@example.com')).toBeUndefined();

    const createResponse = await app.inject({
      method: 'POST',
      url: '/auth/firebase/google',
      payload: { idToken, displayName: '  Asha Rao  ' }
    });

    expect(createResponse.statusCode).toBe(200);

    const tokens = createResponse.json() as AuthTokens;
    expect(tokens.tokenType).toBe('Bearer');
    expect(tokens.expiresInSeconds).toBe(15 * 60);

    const profile = profilesRepository.getFirebaseProfile(firebaseUid);
    expect(profile).toMatchObject({
      phone: null,
      firebaseUid,
      email: 'asha.rao@example.com',
      displayName: 'Asha Rao',
      avatarUrl: 'https://example.com/asha.png'
    });

    if (profile === undefined) {
      throw new Error('Fake profiles repository did not create a Firebase profile');
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

    const secondResponse = await app.inject({
      method: 'POST',
      url: '/auth/firebase/google',
      payload: { idToken }
    });

    expect(secondResponse.statusCode).toBe(200);
    expect(profilesRepository.getFirebaseProfile(firebaseUid)?.id).toBe(profile.id);
  });

  it('logs in an existing Google profile by normalized email and links the Firebase UID', async () => {
    const idToken = 'existing-google-email-token';
    const firebaseUid = 'firebase-google-uid-existing-email';
    const existingProfile: FakeFirebaseProfile = {
      id: randomUUID(),
      phone: null,
      firebaseUid: null,
      email: 'nisha@example.com',
      displayName: 'Nisha Pai',
      avatarUrl: undefined
    };

    profilesRepository.addFirebaseProfile(existingProfile);
    firebaseAuthVerifier.setToken(idToken, {
      uid: firebaseUid,
      email: 'NISHA@EXAMPLE.COM',
      emailVerified: true,
      displayName: 'Different Google Name',
      signInProvider: 'google.com'
    });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/firebase/google',
      payload: { idToken }
    });

    expect(response.statusCode).toBe(200);

    const tokens = response.json() as AuthTokens;
    expect(tokens.tokenType).toBe('Bearer');
    expect(profilesRepository.getFirebaseProfile(firebaseUid)?.id).toBe(existingProfile.id);
    expect(profilesRepository.getFirebaseProfileByEmail('nisha@example.com')).toMatchObject({
      id: existingProfile.id,
      firebaseUid,
      displayName: 'Nisha Pai'
    });
  });

  it('keeps two Google users on independent profile identities and JWT subjects', async () => {
    firebaseAuthVerifier.setToken('multi-google-token-a', {
      uid: 'firebase-google-multi-user-a',
      email: 'multi-user-a@example.com',
      emailVerified: true,
      displayName: 'Multi User A',
      signInProvider: 'google.com'
    });
    firebaseAuthVerifier.setToken('multi-google-token-b', {
      uid: 'firebase-google-multi-user-b',
      email: 'multi-user-b@example.com',
      emailVerified: true,
      displayName: 'Multi User B',
      signInProvider: 'google.com'
    });

    const createUserAResponse = await app.inject({
      method: 'POST',
      url: '/auth/firebase/google',
      payload: { idToken: 'multi-google-token-a', displayName: 'Multi User A' }
    });
    const createUserBResponse = await app.inject({
      method: 'POST',
      url: '/auth/firebase/google',
      payload: { idToken: 'multi-google-token-b', displayName: 'Multi User B' }
    });

    expect(createUserAResponse.statusCode).toBe(200);
    expect(createUserBResponse.statusCode).toBe(200);

    const userATokens = createUserAResponse.json() as AuthTokens;
    const userBTokens = createUserBResponse.json() as AuthTokens;
    const userAProfile = profilesRepository.getFirebaseProfile('firebase-google-multi-user-a');
    const userBProfile = profilesRepository.getFirebaseProfile('firebase-google-multi-user-b');

    expect(userAProfile).toMatchObject({
      email: 'multi-user-a@example.com',
      displayName: 'Multi User A'
    });
    expect(userBProfile).toMatchObject({
      email: 'multi-user-b@example.com',
      displayName: 'Multi User B'
    });
    expect(userAProfile?.id).toBeDefined();
    expect(userBProfile?.id).toBeDefined();
    expect(userAProfile?.id).not.toBe(userBProfile?.id);

    const userAProtectedResponse = await app.inject({
      method: 'GET',
      url: '/auth-test/protected',
      headers: {
        authorization: `Bearer ${userATokens.accessToken}`
      }
    });
    const userBProtectedResponse = await app.inject({
      method: 'GET',
      url: '/auth-test/protected',
      headers: {
        authorization: `Bearer ${userBTokens.accessToken}`
      }
    });

    expect(userAProtectedResponse.statusCode).toBe(200);
    expect(userBProtectedResponse.statusCode).toBe(200);
    expect(userAProtectedResponse.json()).toEqual({
      profileId: userAProfile?.id
    });
    expect(userBProtectedResponse.json()).toEqual({
      profileId: userBProfile?.id
    });

    const returningUserAResponse = await app.inject({
      method: 'POST',
      url: '/auth/firebase/google',
      payload: { idToken: 'multi-google-token-a' }
    });
    const returningUserBResponse = await app.inject({
      method: 'POST',
      url: '/auth/firebase/google',
      payload: { idToken: 'multi-google-token-b' }
    });

    expect(returningUserAResponse.statusCode).toBe(200);
    expect(returningUserBResponse.statusCode).toBe(200);
    expect(profilesRepository.getFirebaseProfile('firebase-google-multi-user-a')?.id).toBe(
      userAProfile?.id
    );
    expect(profilesRepository.getFirebaseProfile('firebase-google-multi-user-b')?.id).toBe(
      userBProfile?.id
    );
  });

  it('rejects blank and overlong Google signup names', async () => {
    firebaseAuthVerifier.setToken('blank-name-token', {
      uid: 'firebase-blank-name-uid',
      email: 'blank-name@example.com',
      emailVerified: true,
      signInProvider: 'google.com'
    });

    const blankResponse = await app.inject({
      method: 'POST',
      url: '/auth/firebase/google',
      payload: { idToken: 'blank-name-token', displayName: '   ' }
    });
    const overlongResponse = await app.inject({
      method: 'POST',
      url: '/auth/firebase/google',
      payload: { idToken: 'blank-name-token', displayName: 'A'.repeat(81) }
    });

    expect(blankResponse.statusCode).toBe(400);
    expect(overlongResponse.statusCode).toBe(400);
    expect(profilesRepository.getFirebaseProfile('firebase-blank-name-uid')).toBeUndefined();
  });

  it('rejects invalid Firebase tokens', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/firebase/google',
      payload: { idToken: 'invalid-firebase-id-token' }
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain('invalid-firebase-id-token');
  });

  it('rejects non-Google and unverified-email Firebase tokens', async () => {
    firebaseAuthVerifier.setToken('password-provider-token', {
      uid: 'firebase-password-uid',
      email: 'password@example.com',
      emailVerified: true,
      signInProvider: 'password'
    });
    firebaseAuthVerifier.setToken('unverified-google-token', {
      uid: 'firebase-unverified-uid',
      email: 'unverified@example.com',
      emailVerified: false,
      signInProvider: 'google.com'
    });

    const nonGoogleResponse = await app.inject({
      method: 'POST',
      url: '/auth/firebase/google',
      payload: { idToken: 'password-provider-token' }
    });
    const unverifiedResponse = await app.inject({
      method: 'POST',
      url: '/auth/firebase/google',
      payload: { idToken: 'unverified-google-token' }
    });

    expect(nonGoogleResponse.statusCode).toBe(401);
    expect(unverifiedResponse.statusCode).toBe(401);
  });
});

function restoreEnv(name: string, originalValue: string | undefined): void {
  if (originalValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = originalValue;
  }
}
