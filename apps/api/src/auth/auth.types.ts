export interface AuthRedisStore {
  get(key: string): Promise<string | null>;
  setEx(key: string, seconds: number, value: string): Promise<void>;
  setPx(key: string, milliseconds: number, value: string): Promise<void>;
  del(key: string): Promise<void>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
  pttl(key: string): Promise<number>;
}

export interface SmsProvider {
  sendOtp(phone: string, code: string): Promise<void>;
}

export interface ProfileRecord {
  id: string;
  phone: string;
}

export interface ProfilesRepository {
  findOrCreateByPhone(phone: string): Promise<ProfileRecord>;
}

export interface AuthenticatedUser {
  profileId: string;
}

export interface AuthRequest {
  headers: {
    authorization?: string | string[];
  };
  currentUser?: AuthenticatedUser;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresInSeconds: number;
}
