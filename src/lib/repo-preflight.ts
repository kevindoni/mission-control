import { execFileSync } from 'child_process';

type RepoAccessState = 'confirmed' | 'failed';

interface ExecFailure extends Error {
  status?: number;
  signal?: string;
  stdout?: Buffer | string;
  stderr?: Buffer | string;
}

export interface RepoPreflightResult {
  ok: boolean;
  access: RepoAccessState;
  repoUrl: string;
  requestedBranch?: string;
  defaultBranch?: string;
  branchExists?: boolean;
  resolvedBranch?: string;
  needsBranchConfirmation: boolean;
  message: string;
  error?: string;
  authHint?: string;
}

export function redactRepoUrl(repoUrl: string): string {
  try {
    const parsed = new URL(repoUrl);
    parsed.username = parsed.username ? '<redacted>' : '';
    parsed.password = parsed.password ? '<redacted>' : '';
    return parsed.toString();
  } catch {
    return repoUrl.replace(/:\/\/[^/@]+@/, '://<redacted>@');
  }
}

function outputSnippet(value: unknown): string | undefined {
  if (!value) return undefined;
  const text = Buffer.isBuffer(value) ? value.toString('utf-8') : String(value);
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, 1000) : undefined;
}

function summarizeExecFailure(error: unknown): string {
  const err = error as ExecFailure;
  return outputSnippet(err.stderr) || outputSnippet(err.stdout) || err.message || 'Git command failed';
}

function parseDefaultBranch(lsRemoteOutput: string): string | undefined {
  return lsRemoteOutput.match(/ref:\s+refs\/heads\/([^\s]+)\s+HEAD/)?.[1];
}

function parseHeadBranches(lsRemoteOutput: string): string[] {
  return lsRemoteOutput
    .split('\n')
    .map(line => line.match(/refs\/heads\/(.+)$/)?.[1])
    .filter((branch): branch is string => Boolean(branch));
}

function authHintForGitError(errorText: string): string {
  const lower = errorText.toLowerCase();
  if (lower.includes('could not resolve host')) {
    return 'Mission Control could not reach the repository host from the server process. Check network/DNS and retry.';
  }
  if (
    lower.includes('repository not found') ||
    lower.includes('authentication failed') ||
    lower.includes('could not read username') ||
    lower.includes('permission denied')
  ) {
    return 'Authenticate git for the same user running Mission Control, using credentials that can access this repository.';
  }
  return 'Verify the repo URL and that the Mission Control server user can run git ls-remote against it.';
}

function gitLsRemote(args: string[]): string {
  return execFileSync('git', ['ls-remote', ...args], {
    encoding: 'utf-8',
    timeout: 30000,
    stdio: 'pipe',
  });
}

export function preflightRepoAccess(repoUrl: string, requestedBranch?: string | null): RepoPreflightResult {
  const branch = requestedBranch?.trim() || undefined;

  try {
    const headOutput = gitLsRemote(['--symref', repoUrl, 'HEAD']);
    const defaultBranch = parseDefaultBranch(headOutput);
    let branchExists: boolean | undefined;
    let resolvedBranch = defaultBranch;

    if (branch) {
      const branchOutput = gitLsRemote(['--heads', repoUrl, branch]);
      const branches = parseHeadBranches(branchOutput);
      branchExists = branches.includes(branch);
      resolvedBranch = branchExists ? branch : defaultBranch;
    }

    const ok = branch ? branchExists === true : Boolean(defaultBranch);
    const needsBranchConfirmation = Boolean(branch && !branchExists && defaultBranch);

    return {
      ok,
      access: 'confirmed',
      repoUrl: redactRepoUrl(repoUrl),
      requestedBranch: branch,
      defaultBranch,
      branchExists,
      resolvedBranch,
      needsBranchConfirmation,
      message: ok
        ? `Repository access confirmed${resolvedBranch ? ` on branch ${resolvedBranch}` : ''}.`
        : `Repository access is confirmed, but branch ${branch || '(none)'} was not found${defaultBranch ? `; detected default branch ${defaultBranch}` : ''}.`,
    };
  } catch (error) {
    const summary = summarizeExecFailure(error);
    return {
      ok: false,
      access: 'failed',
      repoUrl: redactRepoUrl(repoUrl),
      requestedBranch: branch,
      needsBranchConfirmation: false,
      message: 'Mission Control could not verify git access for this repository.',
      error: summary,
      authHint: authHintForGitError(summary),
    };
  }
}
