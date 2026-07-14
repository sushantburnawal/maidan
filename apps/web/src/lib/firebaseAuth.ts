import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  type Auth,
  type UserCredential
} from 'firebase/auth';

interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

let firebaseApp: FirebaseApp | undefined;
let firebaseAuth: Auth | undefined;

const TEST_UID_STORAGE_KEY = 'maidan.firebaseAuth.testUid';

export async function signInWithGoogleForFirebaseIdToken(): Promise<string> {
  if (isFirebaseAuthTestMode()) {
    const baseToken = import.meta.env.VITE_FIREBASE_AUTH_TEST_TOKEN ?? 'local-firebase-id-token';
    const testToken = `${baseToken}:${readOrCreateLocalTestUid()}`;

    console.debug('[firebase-auth] using local test-mode Firebase ID token');

    return testToken;
  }

  const auth = getFirebaseAuth();
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  console.debug('[firebase-auth] starting Google sign-in popup');
  const result = await signInWithPopup(auth, provider);
  console.debug('[firebase-auth] Google sign-in popup succeeded', {
    uid: result.user.uid,
    providerId: providerIdFromCredential(result)
  });

  return result.user.getIdToken();
}

function getFirebaseAuth(): Auth {
  if (firebaseAuth !== undefined) {
    return firebaseAuth;
  }

  const app = getFirebaseApp();
  firebaseAuth = getAuth(app);
  firebaseAuth.useDeviceLanguage();

  return firebaseAuth;
}

function getFirebaseApp(): FirebaseApp {
  if (firebaseApp !== undefined) {
    return firebaseApp;
  }

  const config = getFirebaseWebConfig();

  console.debug('[firebase-auth] initializing Firebase web app', {
    authDomain: config.authDomain,
    projectId: config.projectId,
    hasApiKey: config.apiKey.length > 0,
    hasAppId: config.appId.length > 0
  });

  firebaseApp = initializeApp(config);

  return firebaseApp;
}

function getFirebaseWebConfig(): FirebaseWebConfig {
  const apiKey = readRequiredEnv('VITE_FIREBASE_API_KEY');
  const authDomain = readRequiredEnv('VITE_FIREBASE_AUTH_DOMAIN');
  const projectId = readRequiredEnv('VITE_FIREBASE_PROJECT_ID');
  const appId = readRequiredEnv('VITE_FIREBASE_APP_ID');

  return {
    apiKey,
    authDomain,
    projectId,
    appId
  };
}

function readRequiredEnv(name: string): string {
  const value = import.meta.env[name];

  if (typeof value !== 'string' || value.trim().length === 0 || value === 'replace-me') {
    throw new Error(`${name} is not configured`);
  }

  return value.trim();
}

function isFirebaseAuthTestMode(): boolean {
  return import.meta.env.VITE_FIREBASE_AUTH_TEST_MODE === 'true';
}

function providerIdFromCredential(result: UserCredential): string | undefined {
  const credential = GoogleAuthProvider.credentialFromResult(result);

  return credential?.providerId;
}

function createLocalTestUid(): string {
  const randomValue =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

  return `local-google-${randomValue}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80);
}

function readOrCreateLocalTestUid(): string {
  if (typeof window === 'undefined') {
    return createLocalTestUid();
  }

  try {
    const storedUid = window.localStorage.getItem(TEST_UID_STORAGE_KEY);

    if (storedUid !== null && /^[A-Za-z0-9_-]{1,80}$/.test(storedUid)) {
      return storedUid;
    }

    const nextUid = createLocalTestUid();
    window.localStorage.setItem(TEST_UID_STORAGE_KEY, nextUid);

    return nextUid;
  } catch {
    return createLocalTestUid();
  }
}
