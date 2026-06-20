import { Body, Controller, HttpCode, Post, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { IsString } from 'class-validator';

import { ErrorEnvelopeFilter } from '../src/observability/error-envelope.filter';
import { RateLimitGuard } from '../src/observability/rate-limit.guard';
import { REDIS_CLIENT } from '../src/redis/redis.constants';

class WriteDto {
  @IsString()
  name!: string;
}

@Controller('observability-test')
class ObservabilityTestController {
  @Post('write')
  @HttpCode(200)
  write(@Body() dto: WriteDto): { ok: true } {
    void dto;
    return { ok: true };
  }
}

class FakeRedis {
  private readonly counts = new Map<string, number>();

  reset(): void {
    this.counts.clear();
  }

  async incr(key: string): Promise<number> {
    const nextValue = (this.counts.get(key) ?? 0) + 1;

    this.counts.set(key, nextValue);
    return nextValue;
  }

  async expire(key: string, seconds: number): Promise<void> {
    void key;
    void seconds;
    return;
  }
}

describe('API observability hardening', () => {
  let app: NestFastifyApplication;
  let redis: FakeRedis;
  const originalWriteMax = process.env.RATE_LIMIT_WRITE_MAX;

  beforeAll(async () => {
    redis = new FakeRedis();

    const moduleRef = await Test.createTestingModule({
      controllers: [ObservabilityTestController],
      providers: [
        {
          provide: REDIS_CLIENT,
          useValue: redis
        },
        {
          provide: APP_GUARD,
          useClass: RateLimitGuard
        },
        {
          provide: APP_FILTER,
          useClass: ErrorEnvelopeFilter
        }
      ]
    }).compile();

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

  afterAll(async () => {
    restoreEnv('RATE_LIMIT_WRITE_MAX', originalWriteMax);
    await app.close();
  });

  beforeEach(() => {
    redis.reset();
    process.env.RATE_LIMIT_WRITE_MAX = '100';
  });

  it('wraps validation failures in the error envelope with the correlation id', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/observability-test/write',
      headers: {
        'x-correlation-id': 'validation-correlation'
      },
      payload: {}
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['x-correlation-id']).toBe('validation-correlation');
    expect(response.json()).toEqual({
      error: {
        code: 'BAD_REQUEST',
        correlation_id: 'validation-correlation',
        message: 'Validation failed',
        request_id: 'validation-correlation',
        details: {
          validation_errors: expect.any(Array)
        }
      }
    });
  });

  it('rate limits write endpoints through Redis and returns the same envelope', async () => {
    process.env.RATE_LIMIT_WRITE_MAX = '1';

    const firstResponse = await app.inject({
      method: 'POST',
      url: '/observability-test/write',
      headers: {
        'x-correlation-id': 'rate-correlation'
      },
      payload: {
        name: 'first'
      }
    });
    const secondResponse = await app.inject({
      method: 'POST',
      url: '/observability-test/write',
      headers: {
        'x-correlation-id': 'rate-correlation'
      },
      payload: {
        name: 'second'
      }
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(429);
    expect(secondResponse.json()).toEqual({
      error: {
        code: 'TOO_MANY_REQUESTS',
        correlation_id: 'rate-correlation',
        message: 'Rate limit exceeded',
        request_id: 'rate-correlation'
      }
    });
  });
});

function restoreEnv(name: string, originalValue: string | undefined): void {
  if (originalValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = originalValue;
  }
}
