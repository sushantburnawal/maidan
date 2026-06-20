import {
  BadGatewayException,
  HttpException,
  Injectable,
  ServiceUnavailableException
} from '@nestjs/common';

import type { ActivityPillar } from '@maidan/shared';
import { currentCorrelationHeaders } from '../observability/request-context';
import type {
  ActivityVibeInterest,
  ActivityVibePerson,
  ActivityVibeResponse
} from './activities.types';

type UnknownRecord = Record<string, unknown>;

const PHONE_LIKE_PATTERN = /(?:\+[1-9]\d{1,14}\b|\b\d{10,15}\b)/g;

@Injectable()
export class ActivitiesVibeProxy {
  async getActivityVibe(activityId: string): Promise<ActivityVibeResponse> {
    const response = await fetch(`${getAiBaseUrl()}/internal/activities/${activityId}/vibe`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${getAiInternalToken()}`,
        ...currentCorrelationHeaders()
      }
    });

    if (!response.ok) {
      throw new HttpException(await response.text(), response.status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new BadGatewayException('Activity vibe response was not JSON');
    }

    return toActivityVibeResponse(payload);
  }
}

function toActivityVibeResponse(payload: unknown): ActivityVibeResponse {
  const value = asRecord(payload);
  const people = readArray(value.people).map(toActivityVibePerson);
  const sharedInterests = readArray(value.shared_interests).map(toActivityVibeInterest);
  const participantCount = readInteger(value.participant_count, people.length);

  return {
    activity_id: readText(value.activity_id, 'activity_id'),
    title: redactPhoneLikeText(readText(value.title, 'title')),
    pillar: readPillar(value.pillar),
    participant_count: participantCount,
    people,
    shared_interests: sharedInterests,
    summary: redactPhoneLikeText(readText(value.summary, 'summary'))
  };
}

function toActivityVibePerson(payload: unknown): ActivityVibePerson {
  const value = asRecord(payload);
  const role = value.role === 'host' ? 'host' : 'attendee';

  return {
    display_name: redactPhoneLikeText(readText(value.display_name, 'display_name')),
    role
  };
}

function toActivityVibeInterest(payload: unknown): ActivityVibeInterest {
  const value = asRecord(payload);

  return {
    tag: redactPhoneLikeText(readText(value.tag, 'tag')),
    count: readInteger(value.count, 0)
  };
}

function asRecord(value: unknown): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadGatewayException('Activity vibe response had an invalid shape');
  }

  return value as UnknownRecord;
}

function readText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadGatewayException(`Activity vibe response was missing ${field}`);
  }

  return value.trim();
}

function readPillar(value: unknown): ActivityPillar {
  if (value === 'move' || value === 'learn' || value === 'feel') {
    return value;
  }

  throw new BadGatewayException('Activity vibe response had an invalid pillar');
}

function readArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value;
}

function readInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return fallback;
  }

  return value;
}

function redactPhoneLikeText(value: string): string {
  return value.replace(PHONE_LIKE_PATTERN, '[redacted]');
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
