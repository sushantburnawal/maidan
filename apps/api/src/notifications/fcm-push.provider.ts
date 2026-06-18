import { Injectable, InternalServerErrorException } from '@nestjs/common';
import jwt from 'jsonwebtoken';

import type { PushMessage, PushProvider } from './notifications.types';

interface FcmConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

interface OAuthTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
  error?: unknown;
  error_description?: unknown;
}

@Injectable()
export class FcmPushProvider implements PushProvider {
  private cachedToken: { accessToken: string; expiresAtMs: number } | undefined;

  async send(message: PushMessage): Promise<void> {
    const config = getFcmConfig();
    const accessToken = await this.getAccessToken(config);
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(
        config.projectId
      )}/messages:send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          message: {
            token: message.token,
            notification: message.notification,
            data: message.data
          }
        })
      }
    );

    if (!response.ok) {
      const body = await response.text();

      throw new Error(`FCM push failed with status ${response.status}: ${body}`);
    }
  }

  private async getAccessToken(config: FcmConfig): Promise<string> {
    const now = Date.now();
    const cachedToken = this.cachedToken;

    if (cachedToken !== undefined && cachedToken.expiresAtMs - 60_000 > now) {
      return cachedToken.accessToken;
    }

    const assertion = jwt.sign(
      {
        iss: config.clientEmail,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token'
      },
      config.privateKey,
      {
        algorithm: 'RS256',
        expiresIn: '1h'
      }
    );
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion
      }).toString()
    });
    const parsed = (await response.json()) as OAuthTokenResponse;

    if (!response.ok) {
      throw new Error(
        `FCM OAuth token request failed with status ${response.status}: ${JSON.stringify(parsed)}`
      );
    }

    if (typeof parsed.access_token !== 'string') {
      throw new Error('FCM OAuth token response did not include an access token');
    }

    const expiresInSeconds =
      typeof parsed.expires_in === 'number' && parsed.expires_in > 0 ? parsed.expires_in : 3600;

    this.cachedToken = {
      accessToken: parsed.access_token,
      expiresAtMs: now + expiresInSeconds * 1000
    };

    return parsed.access_token;
  }
}

function getFcmConfig(): FcmConfig {
  const projectId = process.env.FCM_PROJECT_ID;
  const clientEmail = process.env.FCM_CLIENT_EMAIL;
  const privateKey = process.env.FCM_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (
    projectId === undefined ||
    projectId.length === 0 ||
    clientEmail === undefined ||
    clientEmail.length === 0 ||
    privateKey === undefined ||
    privateKey.length === 0
  ) {
    throw new InternalServerErrorException('FCM is not configured');
  }

  return {
    projectId,
    clientEmail,
    privateKey
  };
}
