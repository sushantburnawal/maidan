export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresInSeconds: number;
}

const STORAGE_KEY = 'maidan.auth.tokens';

let currentTokens: AuthTokens | null = readStoredTokens();
const listeners = new Set<(tokens: AuthTokens | null) => void>();

export function getAuthTokens(): AuthTokens | null {
  return currentTokens;
}

export function subscribeAuthTokens(listener: (tokens: AuthTokens | null) => void): () => void {
  listeners.add(listener);
  listener(currentTokens);

  return () => {
    listeners.delete(listener);
  };
}

export function setAuthTokens(tokens: AuthTokens): void {
  currentTokens = tokens;
  writeStoredTokens(tokens);
  notifyListeners();
}

export function clearAuthTokens(): void {
  currentTokens = null;
  removeStoredTokens();
  notifyListeners();
}

function readStoredTokens(): AuthTokens | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const rawValue = window.localStorage.getItem(STORAGE_KEY);

    if (rawValue === null) {
      return null;
    }

    const parsedValue: unknown = JSON.parse(rawValue);

    return isAuthTokens(parsedValue) ? parsedValue : null;
  } catch {
    return null;
  }
}

function writeStoredTokens(tokens: AuthTokens): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
  } catch {
    // Storage is best effort; the in-memory token remains active for this tab.
  }
}

function removeStoredTokens(): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener(currentTokens);
  }
}

function isAuthTokens(value: unknown): value is AuthTokens {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<AuthTokens>;

  return (
    typeof candidate.accessToken === 'string' &&
    candidate.accessToken.length > 0 &&
    typeof candidate.refreshToken === 'string' &&
    candidate.refreshToken.length > 0 &&
    candidate.tokenType === 'Bearer' &&
    typeof candidate.expiresInSeconds === 'number'
  );
}
