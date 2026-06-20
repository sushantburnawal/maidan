import type { SmokeConfig } from './config';
import { runCommand } from './exec';

export class RedisHelper {
  constructor(private readonly config: SmokeConfig) {}

  async get(key: string): Promise<string | null> {
    if (!(await this.exists(key))) {
      return null;
    }

    const value = await this.redisCli(['--raw', 'GET', key]);

    return value.replace(/\r?\n$/, '');
  }

  async exists(key: string): Promise<boolean> {
    return (await this.integer(['EXISTS', key])) > 0;
  }

  async xlen(key: string): Promise<number> {
    return this.integer(['XLEN', key]);
  }

  async llen(key: string): Promise<number> {
    return this.integer(['LLEN', key]);
  }

  async zcard(key: string): Promise<number> {
    return this.integer(['ZCARD', key]);
  }

  async queueActivity(prefix: string, queueName: string): Promise<number> {
    const key = `${prefix}:${queueName}`;
    const [waiting, active, delayed, completed, failed, events] = await Promise.all([
      this.llen(`${key}:wait`),
      this.llen(`${key}:active`),
      this.zcard(`${key}:delayed`),
      this.zcard(`${key}:completed`),
      this.zcard(`${key}:failed`),
      this.xlen(`${key}:events`)
    ]);

    return waiting + active + delayed + completed + failed + events;
  }

  private async integer(args: string[]): Promise<number> {
    const value = (await this.redisCli(args)).trim();

    if (value.length === 0) {
      return 0;
    }

    const parsed = Number(value);

    if (!Number.isFinite(parsed)) {
      throw new Error(`redis-cli ${args.join(' ')} returned a non-number: ${value}`);
    }

    return parsed;
  }

  private async redisCli(args: string[]): Promise<string> {
    const result = await runCommand(
      'docker',
      [
        ...this.config.dockerComposeArgs,
        'exec',
        '-T',
        this.config.services.redis,
        'redis-cli',
        ...args
      ],
      { cwd: this.config.repoRoot }
    );

    return result.stdout;
  }
}
