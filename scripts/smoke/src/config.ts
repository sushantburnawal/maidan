import fs from 'node:fs';
import path from 'node:path';

export interface SmokeConfig {
  repoRoot: string;
  composeFile: string;
  dockerComposeArgs: string[];
  services: {
    postgres: string;
    redis: string;
    api: string;
    ai: string;
  };
  postgres: {
    user: string;
    db: string;
    password: string;
  };
  apiBaseUrl: string;
  aiBaseUrl: string;
  bullmqPrefix: string;
}

export function loadSmokeConfig(): SmokeConfig {
  const repoRoot = path.resolve(__dirname, '../../..');
  const composeFile = path.join(repoRoot, 'infra/docker-compose.local.yml');
  const composeText = fs.readFileSync(composeFile, 'utf8');
  const envFile = readEnvFile(path.join(repoRoot, '.env'));
  const composeDefaults = parseComposeDefaults(composeText);
  const services = parseComposeServices(composeText);

  const readValue = (name: string, fallback: string): string =>
    process.env[name] ?? envFile[name] ?? composeDefaults[name] ?? fallback;

  return {
    repoRoot,
    composeFile,
    dockerComposeArgs: ['compose', '-f', composeFile],
    services: {
      postgres: requireService(services, 'postgres'),
      redis: requireService(services, 'redis'),
      api: requireService(services, 'api'),
      ai: requireService(services, 'ai')
    },
    postgres: {
      user: readValue('POSTGRES_USER', 'postgres'),
      db: readValue('POSTGRES_DB', 'postgres'),
      password: readValue('POSTGRES_PASSWORD', 'postgres')
    },
    apiBaseUrl: readValue('SMOKE_API_BASE_URL', `http://localhost:${readValue('API_PORT', '3000')}`),
    aiBaseUrl: readValue('SMOKE_AI_BASE_URL', `http://localhost:${readValue('AI_PORT', '8000')}`),
    bullmqPrefix: readValue('BULLMQ_PREFIX', 'maidan')
  };
}

function readEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const env: Record<string, string> = {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');

    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    env[key] = unquoteEnvValue(rawValue);
  }

  return env;
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function parseComposeDefaults(composeText: string): Record<string, string> {
  const defaults: Record<string, string> = {};
  const pattern = /\$\{([A-Z0-9_]+):-([^}]+)\}/g;
  let match = pattern.exec(composeText);

  while (match !== null) {
    const [, name, defaultValue] = match;

    if (name !== undefined && defaultValue !== undefined) {
      defaults[name] = defaultValue;
    }

    match = pattern.exec(composeText);
  }

  return defaults;
}

function parseComposeServices(composeText: string): Set<string> {
  const services = new Set<string>();
  const pattern = /^  ([a-zA-Z0-9_-]+):\s*$/gm;
  let match = pattern.exec(composeText);

  while (match !== null) {
    const serviceName = match[1];

    if (serviceName !== undefined) {
      services.add(serviceName);
    }

    match = pattern.exec(composeText);
  }

  return services;
}

function requireService(services: Set<string>, serviceName: string): string {
  if (!services.has(serviceName)) {
    throw new Error(`docker compose service "${serviceName}" was not found in infra/docker-compose.local.yml`);
  }

  return serviceName;
}
