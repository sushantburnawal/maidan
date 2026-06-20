import { UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import { AuthService } from '../src/auth/auth.service';
import type { AuthenticatedUser } from '../src/auth/auth.types';
import { SutradharModule } from '../src/sutradhar/sutradhar.module';

class FakeAuthService {
  constructor(private readonly profileIdsByToken: ReadonlyMap<string, string>) {}

  authenticateAccessToken(accessToken: string): AuthenticatedUser {
    const profileId = this.profileIdsByToken.get(accessToken);

    if (profileId === undefined) {
      throw new UnauthorizedException('Invalid access token');
    }

    return { profileId };
  }
}

describe('Sutradhar module', () => {
  let app: NestFastifyApplication;
  let fetchMock: jest.Mock<Promise<Response>, Parameters<typeof fetch>>;

  const profileId = randomUUID();
  const accessToken = 'explorer-token';
  const previousAiBaseUrl = process.env.AI_BASE_URL;
  const previousAiInternalToken = process.env.AI_INTERNAL_TOKEN;
  const originalFetch = global.fetch;

  beforeAll(async () => {
    process.env.AI_BASE_URL = 'http://ai.test';
    process.env.AI_INTERNAL_TOKEN = 'test-internal-token';

    fetchMock = jest.fn<Promise<Response>, Parameters<typeof fetch>>();
    global.fetch = fetchMock as typeof fetch;

    const moduleRef = await Test.createTestingModule({
      imports: [SutradharModule]
    })
      .overrideProvider(AuthService)
      .useValue(new FakeAuthService(new Map([[accessToken, profileId]])))
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

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(
        'data: {"type":"delta","text":"Try Indiranagar filter coffee brewing."}\n\n' +
          'data: {"type":"final","activity_ids":["activity-1"],"demand_signal_id":null}\n\n',
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8' }
        }
      )
    );
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    restoreEnv('AI_BASE_URL', previousAiBaseUrl);
    restoreEnv('AI_INTERNAL_TOKEN', previousAiInternalToken);
    await app.close();
  });

  it('proxies authenticated chat requests to the AI service with the internal token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/sutradhar/chat',
      headers: {
        authorization: `Bearer ${accessToken}`
      },
      payload: {
        message: 'find me a calm morning thing near Indiranagar this weekend',
        sessionId: 'session-1'
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('activity-1');
    expect(fetchMock).toHaveBeenCalledWith('http://ai.test/sutradhar/chat', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-internal-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        message: 'find me a calm morning thing near Indiranagar this weekend',
        session_id: 'session-1',
        profile_id: profileId
      })
    });
  });

  it('requires the user bearer token before proxying', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/sutradhar/chat',
      payload: {
        message: 'find me a calm morning thing near Indiranagar this weekend',
        sessionId: 'session-1'
      }
    });

    expect(response.statusCode).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});

function restoreEnv(name: string, originalValue: string | undefined): void {
  if (originalValue === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = originalValue;
}
