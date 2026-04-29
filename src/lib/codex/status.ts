import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

interface CommandError extends Error {
  code?: string | number;
  stdout?: string;
  stderr?: string;
  killed?: boolean;
  signal?: NodeJS.Signals;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code?: string | number;
  error?: string;
}

export interface CodexCliStatus {
  installed: boolean;
  authenticated: boolean;
  ready: boolean;
  command: string;
  version?: string;
  authMethod?: string;
  error?: string;
  loginCommand: string;
  checkedAt: string;
}

export const CODEX_COMMAND = process.env.CODEX_CLI_PATH || 'codex';
const LOGIN_COMMAND = `${CODEX_COMMAND} login --device-auth`;

function cleanOutput(output: string): string {
  return output
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('WARNING: proceeding, even though we could not update PATH:'))
    .join('\n')
    .trim();
}

function firstMeaningfulLine(output: string): string | undefined {
  return cleanOutput(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

async function runCodex(args: string[], timeoutMs = 5000): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(CODEX_COMMAND, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        NO_COLOR: '1',
      },
      windowsHide: true,
    });

    return {
      ok: true,
      stdout: cleanOutput(stdout),
      stderr: cleanOutput(stderr),
    };
  } catch (error) {
    const commandError = error as CommandError;

    return {
      ok: false,
      stdout: cleanOutput(commandError.stdout || ''),
      stderr: cleanOutput(commandError.stderr || ''),
      code: commandError.code,
      error: commandError.message,
    };
  }
}

function parseAuthMethod(output: string): string | undefined {
  const match = output.match(/Logged in using\s+(.+)$/im);
  return match?.[1]?.trim();
}

export async function getCodexCliStatus(): Promise<CodexCliStatus> {
  const checkedAt = new Date().toISOString();
  const versionResult = await runCodex(['--version'], 5000);

  if (!versionResult.ok) {
    const error = versionResult.code === 'ENOENT'
      ? 'Codex CLI was not found on the server PATH'
      : versionResult.stderr || versionResult.stdout || versionResult.error || 'Failed to run Codex CLI';

    return {
      installed: false,
      authenticated: false,
      ready: false,
      command: CODEX_COMMAND,
      error,
      loginCommand: LOGIN_COMMAND,
      checkedAt,
    };
  }

  const version = firstMeaningfulLine(versionResult.stdout || versionResult.stderr);
  const loginResult = await runCodex(['login', 'status'], 5000);
  const loginOutput = [loginResult.stdout, loginResult.stderr].filter(Boolean).join('\n');
  const authenticated = loginResult.ok && /Logged in using/i.test(loginOutput);

  return {
    installed: true,
    authenticated,
    ready: authenticated,
    command: CODEX_COMMAND,
    version,
    authMethod: parseAuthMethod(loginOutput),
    error: authenticated ? undefined : loginOutput || loginResult.error || 'Codex CLI is not logged in',
    loginCommand: LOGIN_COMMAND,
    checkedAt,
  };
}
