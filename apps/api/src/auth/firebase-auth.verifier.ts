import { Injectable, InternalServerErrorException, UnauthorizedException } from '@nestjs/common';
import type { App } from 'firebase-admin/app';
import type { DecodedIdToken } from 'firebase-admin/auth';

import type { FirebaseAuthToken, FirebaseAuthVerifier } from './auth.types';

const FIREBASE_AUTH_APP_NAME = 'maidan-auth';

interface FirebaseAdminConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

@Injectable()
export class FirebaseAdminAuthVerifier implements FirebaseAuthVerifier {
  async verifyIdToken(idToken: string): Promise<FirebaseAuthToken> {
    const { getAuth } = await import('firebase-admin/auth');
    const decodedToken = await getAuth(await getFirebaseAdminApp()).verifyIdToken(idToken);

    return mapDecodedToken(decodedToken);
  }
}

export class TestModeFirebaseAuthVerifier implements FirebaseAuthVerifier {
  async verifyIdToken(idToken: string): Promise<FirebaseAuthToken> {
    if (process.env.NODE_ENV === 'production') {
      throw new InternalServerErrorException('Firebase auth test mode is not allowed in production');
    }

    const expectedToken = configuredSecret(process.env.FIREBASE_AUTH_TEST_TOKEN);

    if (expectedToken === undefined) {
      throw new UnauthorizedException('Invalid Firebase ID token');
    }

    const uid = testUidFromToken(idToken, expectedToken);
    const email =
      idToken === expectedToken
        ? configuredSecret(process.env.FIREBASE_AUTH_TEST_EMAIL) ?? testEmailForUid(uid)
        : testEmailForUid(uid);
    const displayName =
      configuredSecret(process.env.FIREBASE_AUTH_TEST_DISPLAY_NAME) ?? 'Local Google User';
    const picture = configuredSecret(process.env.FIREBASE_AUTH_TEST_PHOTO_URL);

    return {
      uid,
      email,
      emailVerified: true,
      displayName,
      picture,
      signInProvider: 'google.com'
    };
  }
}

export function createFirebaseAuthVerifier(): FirebaseAuthVerifier {
  return process.env.FIREBASE_AUTH_TEST_MODE === 'true'
    ? new TestModeFirebaseAuthVerifier()
    : new FirebaseAdminAuthVerifier();
}

async function getFirebaseAdminApp(): Promise<App> {
  const { cert, getApps, initializeApp } = await import('firebase-admin/app');
  const existingApp = getApps().find((app) => app.name === FIREBASE_AUTH_APP_NAME);

  if (existingApp !== undefined) {
    return existingApp;
  }

  const config = getFirebaseAdminConfig();

  return initializeApp(
    {
      credential: cert({
        projectId: config.projectId,
        clientEmail: config.clientEmail,
        privateKey: config.privateKey
      }),
      projectId: config.projectId
    },
    FIREBASE_AUTH_APP_NAME
  );
}

function getFirebaseAdminConfig(): FirebaseAdminConfig {
  const projectId = configuredSecret(process.env.FIREBASE_PROJECT_ID);
  const clientEmail = configuredSecret(process.env.FIREBASE_CLIENT_EMAIL);
  const privateKey = configuredSecret(process.env.FIREBASE_PRIVATE_KEY)?.replace(/\\n/g, '\n');

  if (projectId === undefined || clientEmail === undefined || privateKey === undefined) {
    throw new InternalServerErrorException('Firebase auth is not configured');
  }

  return {
    projectId,
    clientEmail,
    privateKey
  };
}

function mapDecodedToken(decodedToken: DecodedIdToken): FirebaseAuthToken {
  return {
    uid: decodedToken.uid,
    email: readString(decodedToken.email) ?? '',
    emailVerified: decodedToken.email_verified === true,
    displayName: readString(decodedToken.name),
    picture: readString(decodedToken.picture),
    signInProvider: readString(decodedToken.firebase?.sign_in_provider)
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function configuredSecret(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  if (trimmed === undefined || trimmed.length === 0 || trimmed === 'replace-me') {
    return undefined;
  }

  return trimmed;
}

function testUidFromToken(idToken: string, expectedToken: string): string {
  if (idToken === expectedToken) {
    return configuredSecret(process.env.FIREBASE_AUTH_TEST_UID) ?? 'local-google-user';
  }

  const prefix = `${expectedToken}:`;

  if (!idToken.startsWith(prefix)) {
    throw new UnauthorizedException('Invalid Firebase ID token');
  }

  const uid = idToken.slice(prefix.length);

  if (!/^[A-Za-z0-9_-]{1,80}$/.test(uid)) {
    throw new UnauthorizedException('Invalid Firebase ID token');
  }

  return uid;
}

function testEmailForUid(uid: string): string {
  return `${uid.toLowerCase()}@maidan.test`;
}
