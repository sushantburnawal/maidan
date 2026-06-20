import { BadGatewayException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Readable } from 'node:stream';

import { SutradharChatDto } from './dto/sutradhar-chat.dto';
import { currentCorrelationHeaders } from '../observability/request-context';
import type { SutradharProxyResponse } from './sutradhar.types';

@Injectable()
export class SutradharService {
  async chat(profileId: string, dto: SutradharChatDto): Promise<SutradharProxyResponse> {
    const response = await fetch(`${getAiBaseUrl()}/sutradhar/chat`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${getAiInternalToken()}`,
        'content-type': 'application/json',
        ...currentCorrelationHeaders()
      },
      body: JSON.stringify({
        message: dto.message,
        session_id: dto.sessionId,
        profile_id: profileId
      })
    });

    if (!response.ok) {
      throw new HttpException(await response.text(), response.status);
    }

    if (response.body === null) {
      throw new BadGatewayException('Sutradhar response body was empty');
    }

    return {
      contentType: response.headers.get('content-type') ?? 'text/event-stream',
      body: Readable.fromWeb(response.body)
    };
  }
}

function getAiBaseUrl(): string {
  const baseUrl = process.env.AI_BASE_URL ?? 'http://localhost:8000';
  return baseUrl.replace(/\/+$/, '');
}

function getAiInternalToken(): string {
  const token = process.env.AI_INTERNAL_TOKEN;
  if (token === undefined || token.length === 0 || token === 'replace-me') {
    throw new ServiceUnavailableException('AI_INTERNAL_TOKEN is not configured');
  }
  return token;
}
