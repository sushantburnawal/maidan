import { execFile } from 'node:child_process';

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly args: string[],
    readonly stdout: string,
    readonly stderr: string,
    readonly exitCode: number | string | null
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

export function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; maxBuffer?: number }
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        encoding: 'utf8',
        maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const exitCode = typeof error.code === 'number' || typeof error.code === 'string'
            ? error.code
            : null;

          reject(
            new CommandError(
              `Command failed: ${command} ${args.join(' ')}`,
              command,
              args,
              stdout,
              stderr,
              exitCode
            )
          );
          return;
        }

        resolve({ stdout, stderr });
      }
    );
  });
}
