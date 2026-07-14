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

export interface FirebaseAuthToken {
  uid: string;
  email: string;
  emailVerified: boolean;
  displayName?: string;
  picture?: string;
  signInProvider?: string;
}

export interface FirebaseAuthVerifier {
  verifyIdToken(idToken: string): Promise<FirebaseAuthToken>;
}

export interface ProfileRecord {
  id: string;
  phone: string | null;
}

export interface FirebaseProfileIdentity {
  firebaseUid: string;
  email: string;
  signupDisplayName?: string;
  avatarUrl?: string;
}

export type FirebaseProfileMatchKind = 'email' | 'firebase_uid';

export type FirebaseProfileResolution =
  | {
      status: 'signup_required';
    }
  | {
      status: 'found';
      matchedBy: FirebaseProfileMatchKind;
      profile: ProfileRecord;
    }
  | {
      status: 'created';
      profile: ProfileRecord;
    };

export interface ProfilesRepository {
  findOrCreateByPhone(phone: string): Promise<ProfileRecord>;
  resolveFirebaseIdentity(identity: FirebaseProfileIdentity): Promise<FirebaseProfileResolution>;
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

export interface FirebaseGoogleSignupRequiredResponse {
  signupRequired: true;
  email: string;
  suggestedDisplayName?: string;
}

export type FirebaseGoogleAuthResponse = AuthTokens | FirebaseGoogleSignupRequiredResponse;
