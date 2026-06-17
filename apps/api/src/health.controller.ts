import { Controller, Get } from '@nestjs/common';
import { healthResponseSchema, type HealthResponse } from '@maidan/shared';
import { execFileSync } from 'node:child_process';

@Controller('health')
export class HealthController {
  @Get()
  getHealth(): HealthResponse {
    return healthResponseSchema.parse({
      status: 'ok',
      service: 'api',
      commit: getCommitSha()
    });
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
