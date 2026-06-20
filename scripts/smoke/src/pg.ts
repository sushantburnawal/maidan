import type { SmokeConfig } from './config';
import { runCommand } from './exec';

export class PgHelper {
  constructor(private readonly config: SmokeConfig) {}

  async queryRows<T>(sql: string): Promise<T[]> {
    const wrappedSql = `
      select coalesce(json_agg(row_to_json(smoke_rows)), '[]'::json)
      from (
        ${stripTrailingSemicolon(sql)}
      ) smoke_rows
    `;
    const stdout = await this.psql(['-t', '-A', '-c', wrappedSql]);
    const trimmed = stdout.trim();

    return trimmed.length === 0 ? [] : (JSON.parse(trimmed) as T[]);
  }

  async queryOne<T>(sql: string): Promise<T | null> {
    const rows = await this.queryRows<T>(sql);

    return rows[0] ?? null;
  }

  async scalar(sql: string): Promise<string> {
    const stdout = await this.psql(['-t', '-A', '-c', sql]);

    return stdout.trim();
  }

  async execute(sql: string): Promise<void> {
    await this.psql(['-c', sql]);
  }

  private async psql(args: string[]): Promise<string> {
    const result = await runCommand(
      'docker',
      [
        ...this.config.dockerComposeArgs,
        'exec',
        '-T',
        this.config.services.postgres,
        'psql',
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        this.config.postgres.user,
        '-d',
        this.config.postgres.db,
        ...args
      ],
      { cwd: this.config.repoRoot }
    );

    return result.stdout;
  }
}

export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function sqlUuid(value: string): string {
  return `${sqlString(value)}::uuid`;
}

export function sqlUuidArray(values: string[]): string {
  if (values.length === 0) {
    return 'array[]::uuid[]';
  }

  return `array[${values.map(sqlUuid).join(', ')}]`;
}

function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '');
}
