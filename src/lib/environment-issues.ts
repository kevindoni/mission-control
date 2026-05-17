export type EnvironmentIssueCode =
  | 'missing_tool'
  | 'missing_dependency'
  | 'repo_access'
  | 'runtime_auth';

export type EnvironmentIssueFixMode = 'command' | 'manual' | 'settings';

export interface EnvironmentIssueAction {
  mode: EnvironmentIssueFixMode;
  label: string;
  description: string;
  command?: string;
  commandSource?: string;
  settingsHref?: string;
}

export interface EnvironmentIssue {
  code: EnvironmentIssueCode;
  title: string;
  summary: string;
  userMessage: string;
  severity: 'warning' | 'danger';
  action: EnvironmentIssueAction;
  retryLabel: string;
}

function normalizeText(parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join('\n').trim();
}

function cleanCommand(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const firstLine = command
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;

  return firstLine
    .replace(/^[$>]\s*/, '')
    .replace(/[.;]\s*$/, '')
    .trim();
}

function cleanMissingName(name: string | undefined): string | null {
  if (!name) return null;
  const cleaned = name
    .replace(/^the\s+/i, '')
    .replace(/[.;,/].*$/, '')
    .trim();

  if (!cleaned || ['the', 'a', 'an', 'or', 'and', 'required', 'local'].includes(cleaned.toLowerCase())) {
    return null;
  }

  return cleaned;
}

function extractSuggestedCommand(text: string): { command: string; source: string } | null {
  const patterns: Array<{ source: string; regex: RegExp }> = [
    { source: 'suggested setup command', regex: /suggested\s+(?:setup\s+)?command:\s*([^\n]+)/i },
    { source: 'error suggestion', regex: /\b(?:use|using):\s*([^\n]+)/i },
    { source: 'quoted command suggestion', regex: /\b(?:run|try|execute|use)\b\s+[`'"]([^`'"\n]+)[`'"]/i },
    { source: 'install suggestion', regex: /(?:install(?: it)? (?:with|using)|via)\s+[`'"]?([^`'"\n]+)/i },
    { source: 'plain command suggestion', regex: /\b(?:run|try|execute|use)\b\s*:\s*([^\n]+)/i },
  ];

  for (const { source, regex } of patterns) {
    const match = text.match(regex);
    const command = cleanCommand(match?.[1]);
    if (command) return { command, source };
  }

  return null;
}

function extractMissingName(text: string): string | null {
  const patterns = [
    /cannot execute tool\s+['"`]?([A-Za-z0-9_.+-]+)['"`]?/i,
    /(?:command|tool|binary|executable)\s+['"`]?([A-Za-z0-9_.+-]+)['"`]?\s+(?:not found|is missing|missing)/i,
    /['"`]([A-Za-z0-9_.+-]+)['"`]\s*:\s*command not found/i,
    /\b([A-Za-z0-9_.+-]+):\s*command not found/i,
    /missing\s+(?:the\s+)?[`'"]?([A-Za-z0-9_.+-]+(?:\s+[A-Za-z0-9_.+-]+){0,3})[`'"]?(?=\s*(?:;|,|\.|\/|$|\n))/i,
    /missing\s+[`'"]?([A-Za-z0-9_.+-]+)[`'"]?(?:\s|;|,|$)/i,
    /failed to find\s+[`'"]?([A-Za-z0-9_.+-]+)[`'"]?/i,
    /No such file or directory.*?['"`]([A-Za-z0-9_.+-]+)['"`]/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const name = cleanMissingName(match?.[1]);
    if (name) return name;
  }

  return null;
}

function classifySetupIssue(text: string): EnvironmentIssue | null {
  const normalized = text.toLowerCase();
  const hasGenericMissingEnvironmentSignal =
    /\bmissing\s+(?:the\s+)?[A-Za-z0-9_.+-]/i.test(text) &&
    (
      normalized.includes('environment') ||
      normalized.includes('build') ||
      normalized.includes('test') ||
      normalized.includes('compiler') ||
      normalized.includes('dependency') ||
      normalized.includes('package') ||
      normalized.includes('tool') ||
      normalized.includes('binary') ||
      normalized.includes('executable')
    );
  const hasSetupSignal =
    normalized.includes('command not found') ||
    normalized.includes('tool not found') ||
    normalized.includes('binary not found') ||
    normalized.includes('executable not found') ||
    normalized.includes('cannot execute tool') ||
    normalized.includes('no such file or directory') ||
    normalized.includes('missing dependency') ||
    normalized.includes('missing package') ||
    normalized.includes('required dependency') ||
    normalized.includes('failed to find') ||
    normalized.includes('not installed') ||
    hasGenericMissingEnvironmentSignal;

  if (!hasSetupSignal) return null;

  const suggested = extractSuggestedCommand(text);
  const missingName = extractMissingName(text);
  const isDependency = normalized.includes('dependency') || normalized.includes('package');
  const code: EnvironmentIssueCode = isDependency ? 'missing_dependency' : 'missing_tool';
  const noun = missingName
    ? `\`${missingName}\``
    : isDependency
      ? 'a required dependency'
      : 'a required tool';

  return {
    code,
    title: missingName ? `Missing ${missingName}` : isDependency ? 'Missing dependency' : 'Missing tool',
    summary: `The local environment is missing ${noun}.`,
    userMessage: suggested
      ? 'Review the suggested setup command, approve it if it looks right, then retry the assigned agent.'
      : 'Enter a setup command to run here, or fix the environment outside Mission Control and retry the assigned agent.',
    severity: 'danger',
    action: {
      mode: suggested ? 'command' : 'manual',
      label: suggested ? 'Approve command & retry' : 'Run setup command',
      description: suggested
        ? 'Runs the exact setup command shown here after user approval, then retries the assigned agent.'
        : 'Mission Control could not infer a setup command from the logs.',
      command: suggested?.command,
      commandSource: suggested?.source,
    },
    retryLabel: 'Retry agent',
  };
}

export function classifyEnvironmentIssue(text: string | null | undefined): EnvironmentIssue | null {
  return classifyEnvironmentIssueFromTexts([text]);
}

export function classifyEnvironmentIssueFromTexts(parts: Array<string | null | undefined>): EnvironmentIssue | null {
  const text = normalizeText(parts);
  if (!text) return null;

  const normalized = text.toLowerCase();

  if (
    normalized.includes('repository not found') ||
    normalized.includes('could not read from remote repository') ||
    normalized.includes('authentication failed') ||
    normalized.includes('repo access') ||
    normalized.includes('private repo')
  ) {
    const suggested = extractSuggestedCommand(text);
    return {
      code: 'repo_access',
      title: 'Repository access needed',
      summary: 'The agent cannot access the target repository from this machine.',
      userMessage: suggested
        ? 'Review the repository access command, approve it if it looks right, then retry the assigned agent.'
        : 'Confirm repository authentication and access, then retry the assigned agent.',
      severity: 'warning',
      action: {
        mode: suggested ? 'command' : 'manual',
        label: suggested ? 'Approve command & retry' : 'Fix manually',
        description: suggested
          ? 'Runs the exact repository access command shown here after user approval.'
          : 'Mission Control could not infer an authentication command from the logs.',
        command: suggested?.command,
        commandSource: suggested?.source,
      },
      retryLabel: 'Retry agent',
    };
  }

  if (
    normalized.includes('runtime is not ready') ||
    normalized.includes('runtime connection') ||
    normalized.includes('not authenticated')
  ) {
    return {
      code: 'runtime_auth',
      title: 'Agent runtime needs setup',
      summary: 'The selected agent runtime is not connected or authenticated.',
      userMessage: 'Fix the runtime connection in Settings, then retry the assigned agent.',
      severity: 'warning',
      action: {
        mode: 'settings',
        label: 'Open Settings',
        description: 'Check runtime authentication and connection status.',
        settingsHref: '/settings',
      },
      retryLabel: 'Retry agent',
    };
  }

  return classifySetupIssue(text);
}

export function hasEnvironmentIssueCommand(issue: EnvironmentIssue): boolean {
  return issue.action.mode === 'command' && Boolean(issue.action.command);
}
