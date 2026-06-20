import { Controller, Get, Res } from '@nestjs/common';
import { healthResponseSchema, type HealthResponse } from '@maidan/shared';
import { execFileSync } from 'node:child_process';

import { ApiHealthService, type ReadyResponse } from './observability/api-health.service';

interface ResponseLike {
  status(code: number): ResponseLike;
}

@Controller('health')
export class HealthController {
  constructor(private readonly apiHealth: ApiHealthService) {}

  @Get()
  getHealth(): HealthResponse {
    return healthResponseSchema.parse({
      status: 'ok',
      service: 'api',
      commit: getCommitSha()
    });
  }

  @Get('ready')
  async getReadiness(@Res({ passthrough: true }) response: ResponseLike): Promise<ReadyResponse> {
    const readiness = await this.apiHealth.readiness();

    if (readiness.status !== 'ok') {
      response.status(503);
    }

    return readiness;
  }
}

function getCommitSha(): string {
  const commitFromEnv = process.env.COMMIT_SHA ?? process.env.RAILWAY_GIT_COMMIT_SHA;

  if (commitFromEnv !== undefined && commitFromEnv.length > 0) {
    return commitFromEnv;
  }

  try {
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();

    return commit.length > 0 ? commit : 'unknown';
  } catch {
    return 'unknown';
  }
}
