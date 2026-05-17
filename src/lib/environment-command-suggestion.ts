import fs from 'fs';
import os from 'os';
import { completeJSON } from '@/lib/autopilot/llm';
import type { EnvironmentIssue } from '@/lib/environment-issues';
import type { Task } from '@/lib/types';

interface RecentActivity {
  created_at?: string;
  activity_type?: string;
  message: string;
  metadata?: string | null;
}

export interface EnvironmentCommandSuggestion {
  canFixWithCommand: boolean;
  command?: string;
  rationale?: string;
  confidence?: 'low' | 'medium' | 'high';
}

interface SuggestionResponse {
  can_fix_with_command?: boolean;
  command?: string | null;
  rationale?: string;
  confidence?: 'low' | 'medium' | 'high';
}

const MAX_LOG_CHARS = 12_000;
const MAX_ACTIVITY_CHARS = 12_000;

function cleanCommand(command: string | null | undefined): string | undefined {
  if (!command) return undefined;
  const firstLine = command
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean);

  return firstLine
    ?.replace(/^[$>]\s*/, '')
    .replace(/[.;]\s*$/, '')
    .trim() || undefined;
}

function normalizeCommand(command: string | undefined): string | undefined {
  return command?.trim().replace(/\s+/g, ' ');
}

function safeJsonParse<T = unknown>(value: string | null | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function readLogTail(logPath: unknown): string | undefined {
  if (!logPath || typeof logPath !== 'string') return undefined;

  try {
    const stat = fs.statSync(logPath);
    if (!stat.isFile()) return undefined;
    const start = Math.max(0, stat.size - MAX_LOG_CHARS);
    const fd = fs.openSync(logPath, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString('utf8').trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function formatActivities(activities: RecentActivity[]): string {
  return activities
    .map((activity) => {
      const metadata = safeJsonParse<Record<string, unknown>>(activity.metadata || undefined);
      const lines = [
        `- ${activity.created_at || 'unknown time'} [${activity.activity_type || 'activity'}]: ${activity.message}`,
      ];

      if (metadata?.final_message) {
        lines.push(`  Final message: ${String(metadata.final_message)}`);
      }

      const logTail = readLogTail(metadata?.log_path);
      if (logTail) {
        lines.push(`  Log tail:\n${logTail}`);
      }

      return lines.join('\n');
    })
    .join('\n\n')
    .slice(-MAX_ACTIVITY_CHARS);
}

export async function suggestEnvironmentFixCommand(input: {
  task: Task;
  issue: EnvironmentIssue;
  activities: RecentActivity[];
  requestText?: string;
  attemptedCommands?: string[];
  blockedCommands?: string[];
}): Promise<EnvironmentCommandSuggestion> {
  const blockedCommands = Array.from(new Set(
    (input.blockedCommands || input.attemptedCommands || [])
      .map(command => normalizeCommand(cleanCommand(command)))
      .filter((command): command is string => Boolean(command))
  ));

  const prompt = `You are helping Mission Control recover an agent task blocked by a local environment issue.

Return only JSON with this exact shape:
{
  "can_fix_with_command": true | false,
  "command": "single shell command to run, or null",
  "confidence": "low" | "medium" | "high",
  "rationale": "one short sentence"
}

Rules:
- Use the task logs and error text as the source of truth.
- Prefer an exact command already present in the logs.
- Do not return a command that appears in "Commands blocked in the current recovery generation".
- If no exact command is present, infer one only when the missing dependency/tool and host platform make the command clear.
- The command must be one shell command line suitable for the server running Mission Control.
- Do not include placeholders, secrets, tokens, or interactive explanation text in the command.
- If the only clear command is blocked in the current recovery generation, return can_fix_with_command=false and command=null.
- If a single concrete command is not clear, return can_fix_with_command=false and command=null.
- Do not assume a specific OS, package manager, repository host, language, or framework unless the evidence below supports it.

Server platform:
- os.platform(): ${os.platform()}
- os.release(): ${os.release()}
- os.arch(): ${os.arch()}

Task:
- id: ${input.task.id}
- title: ${input.task.title}
- status: ${input.task.status}
- workspace_path: ${input.task.workspace_path || '(none)'}
- repo_url: ${input.task.repo_url || '(none)'}
- repo_branch: ${input.task.repo_branch || '(none)'}

Classified issue:
${JSON.stringify(input.issue, null, 2)}

Current error text:
${input.requestText || ''}
${input.task.status_reason || ''}
${input.task.planning_dispatch_error || ''}

Commands blocked in the current recovery generation:
${blockedCommands.length > 0 ? blockedCommands.map(command => `- ${command}`).join('\n') : '- (none)'}

Recent activities and logs:
${formatActivities(input.activities)}`;

  const result = await completeJSON<SuggestionResponse>(prompt, {
    temperature: 0.1,
    maxTokens: 700,
    timeoutMs: 120_000,
  });

  const command = cleanCommand(result.data.command);
  const normalizedCommand = normalizeCommand(command);
  const returnsBlockedCommand = Boolean(
    normalizedCommand && blockedCommands.includes(normalizedCommand)
  );
  const canFixWithCommand = Boolean(result.data.can_fix_with_command && command && !returnsBlockedCommand);

  return {
    canFixWithCommand,
    command: canFixWithCommand ? command : undefined,
    confidence: result.data.confidence,
    rationale: returnsBlockedCommand
      ? 'The only suggested command is blocked in the current recovery generation.'
      : result.data.rationale,
  };
}
