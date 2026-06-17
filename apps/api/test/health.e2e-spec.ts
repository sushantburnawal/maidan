import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';

describe('GET /health', () => {
  let app: NestFastifyApplication;
  const originalCommitSha = process.env.COMMIT_SHA;

  beforeAll(async () => {
    process.env.COMMIT_SHA = 'test-sha';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule]
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    if (originalCommitSha === undefined) {
      delete process.env.COMMIT_SHA;
    } else {
      process.env.COMMIT_SHA = originalCommitSha;
    }

    await app.close();
  });

  it('returns the API health response', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health'
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      service: 'api',
      commit: 'test-sha'
    });
  });
});
