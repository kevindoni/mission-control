import { exec, type ExecException } from 'child_process';
import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { queryAll, queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { dispatchTaskFromServer } from '@/lib/server-dispatch';
import {
  suggestEnvironmentFixCommand,
  type EnvironmentCommandSuggestion,
} from '@/lib/environment-command-suggestion';
import {
  classifyEnvironmentIssueFromTexts,
  hasEnvironmentIssueCommand,
  type EnvironmentIssue,
  type EnvironmentIssueCode,
} from '@/lib/environment-issues';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';

const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const RUNNING_STALE_MS = COMMAND_TIMEOUT_MS + 60 * 1000;
const MAX_OUTPUT_CHARS = 6000;

const runningEnvironmentFixes = new Map<string, { command: string; startedAt: string }>();

interface RecentActivity {
  created_at?: string;
  activity_type?: string;
  message: string;
  metadata?: string | null;
}

interface EnvironmentFixActivity {
  id: string;
  created_at: string;
  activity_type: string;
  message: string;
  metadata?: string | null;
}

interface EnvironmentFixRun {
  task: Task;
  issue: EnvironmentIssue;
  suggestion: EnvironmentCommandSuggestion | null;
  command: string;
  commandSource: string;
  retry: boolean;
  generation: number;
}

interface EnvironmentFixMetadata {
  issue?: EnvironmentIssue;
  suggestion?: EnvironmentCommandSuggestion | null;
  nextSuggestion?: EnvironmentCommandSuggestion | null;
  command?: string;
  commandSource?: string;
  error?: string;
  failureFingerprint?: string;
  generation?: number;
  repeatedFailure?: boolean;
  stdout?: string;
  stderr?: string;
  timeoutMs?: number;
}

type EnvironmentRecoveryAttemptStatus = 'running' | 'failed' | 'completed' | 'retry_failed' | 'stale';

interface EnvironmentRecoveryAttempt {
  id: string;
  createdAt: string;
  status: EnvironmentRecoveryAttemptStatus;
  command?: string;
  commandSource?: string;
  generation: number;
  message: string;
  error?: string;
  failureFingerprint?: string;
  repeatedFailure?: boolean;
  stdout?: string;
  stderr?: string;
  suggestion?: EnvironmentCommandSuggestion | null;
  nextSuggestion?: EnvironmentCommandSuggestion | null;
}

interface EnvironmentRecoveryState {
  issue: EnvironmentIssue;
  running: boolean;
  runningFix?: { command: string; startedAt: string };
  attempts: EnvironmentRecoveryAttempt[];
  generation: number;
  failedCommands: string[];
  repeatedFailures: Array<{ command: string; generation: number; firstGeneration: number; failureFingerprint: string }>;
  nextSuggestion?: EnvironmentCommandSuggestion | null;
}

function compactOutput(value: string | Buffer | undefined): string {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : value || '';
  return text.length > MAX_OUTPUT_CHARS ? text.slice(-MAX_OUTPUT_CHARS) : text;
}

function normalizeCommand(command: string | undefined): string | undefined {
  return command?.trim().replace(/\s+/g, ' ');
}

function safeJsonParse<T = unknown>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function normalizeFailureText(value: string | undefined): string {
  return (value || '')
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}[t\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?\b/g, '<timestamp>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/g, '<hex>')
    .replace(/\[[^\]]*?\d+:\d+[^\]]*?\]/g, '[process]')
    .replace(/\bpid\s+\d+\b/g, 'pid <num>')
    .replace(/\b\d{4,}\b/g, '<num>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

function createFailureFingerprint(value: string | undefined): string | undefined {
  const normalized = normalizeFailureText(value);
  if (!normalized) return undefined;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function formatCommandFailure(
  command: string,
  error: ExecException,
  stdout: string | Buffer | undefined,
  stderr: string | Buffer | undefined
): string {
  const stderrText = compactOutput(stderr);
  const stdoutText = compactOutput(stdout);
  const timeoutText = error.killed
    ? `Command did not finish before the ${Math.round(COMMAND_TIMEOUT_MS / 1000)}s timeout and was stopped.`
    : '';
  const detail = [stderrText, stdoutText, timeoutText, error.message].filter(Boolean).join('\n').trim();
  return detail || `Command failed: ${command}`;
}

function collectIssueText(task: Task, activities: RecentActivity[], requestText?: string): Array<string | null | undefined> {
  return [
    requestText,
    task.status_reason,
    task.planning_dispatch_error,
    ...activities.flatMap((activity) => [activity.message, activity.metadata || undefined]),
  ];
}

function recordActivity(taskId: string, agentId: string | null, type: string, message: string, metadata?: object): string {
  const id = crypto.randomUUID();
  run(
    `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, taskId, agentId, type, message, metadata ? JSON.stringify(metadata) : null, new Date().toISOString()]
  );
  return id;
}

function getRunningEnvironmentFix(taskId: string): { command: string; startedAt: string } | null {
  const inMemory = runningEnvironmentFixes.get(taskId);
  if (inMemory) return inMemory;

  const latest = queryOne<EnvironmentFixActivity>(
    `SELECT id, created_at, activity_type, message, metadata
     FROM task_activities
     WHERE task_id = ?
       AND activity_type IN ('environment_fix_started', 'environment_fix_failed', 'environment_fix_completed', 'environment_fix_retry_failed')
     ORDER BY created_at DESC
     LIMIT 1`,
    [taskId]
  );

  if (!latest || latest.activity_type !== 'environment_fix_started') return null;

  const startedAtMs = new Date(latest.created_at).getTime();
  if (!Number.isFinite(startedAtMs) || Date.now() - startedAtMs > RUNNING_STALE_MS) return null;

  let command = latest.message.replace(/^Running approved environment command:\s*/i, '').trim();
  const metadata = safeJsonParse<EnvironmentFixMetadata>(latest.metadata);
  if (metadata?.command) command = metadata.command;

  return { command, startedAt: latest.created_at };
}

function getEnvironmentFixActivities(taskId: string, limit = 30): EnvironmentFixActivity[] {
  return queryAll<EnvironmentFixActivity>(
    `SELECT id, created_at, activity_type, message, metadata
     FROM task_activities
     WHERE task_id = ?
       AND activity_type IN ('environment_fix_started', 'environment_fix_failed', 'environment_fix_completed', 'environment_fix_retry_failed')
     ORDER BY created_at DESC
     LIMIT ?`,
    [taskId, limit]
  );
}

function getRecentContextActivities(taskId: string): RecentActivity[] {
  return queryAll<RecentActivity>(
    `SELECT created_at, activity_type, message, metadata
     FROM task_activities
     WHERE task_id = ?
       AND activity_type IN (
         'environment_blocked',
         'status_changed',
         'environment_fix_started',
         'environment_fix_failed',
         'environment_fix_completed',
         'environment_fix_retry_failed'
       )
     ORDER BY created_at DESC
     LIMIT 15`,
    [taskId]
  );
}

function commandFromActivity(activity: EnvironmentFixActivity, metadata: EnvironmentFixMetadata | null): string | undefined {
  if (metadata?.command) return metadata.command;
  const fromStartedMessage = activity.message.replace(/^Running approved environment command:\s*/i, '').trim();
  return fromStartedMessage === activity.message ? undefined : fromStartedMessage;
}

function buildRecoveryState(taskId: string, issue: EnvironmentIssue): EnvironmentRecoveryState {
  const runningFix = getRunningEnvironmentFix(taskId);
  const activities = getEnvironmentFixActivities(taskId).reverse();
  const attempts: EnvironmentRecoveryAttempt[] = [];
  const firstFailureByCommandAndFingerprint = new Map<string, { generation: number }>();
  const repeatedFailures: EnvironmentRecoveryState['repeatedFailures'] = [];
  let generation = 0;

  for (const activity of activities) {
    const metadata = safeJsonParse<EnvironmentFixMetadata>(activity.metadata);
    const command = commandFromActivity(activity, metadata);
    const metadataGeneration = typeof metadata?.generation === 'number' ? metadata.generation : undefined;

    if (activity.activity_type === 'environment_fix_started') {
      attempts.push({
        id: activity.id,
        createdAt: activity.created_at,
        status: 'running',
        command,
        commandSource: metadata?.commandSource,
        generation: metadataGeneration ?? generation,
        message: activity.message,
        suggestion: metadata?.suggestion,
      });
      continue;
    }

    const status = activity.activity_type === 'environment_fix_completed'
      ? 'completed'
      : activity.activity_type === 'environment_fix_retry_failed'
        ? 'retry_failed'
        : 'failed';
    const matchingAttempt = command
      ? [...attempts].reverse().find((attempt) => (
        attempt.status === 'running' &&
        normalizeCommand(attempt.command) === normalizeCommand(command)
      ))
      : undefined;
    const attemptGeneration = metadataGeneration ?? matchingAttempt?.generation ?? generation;
    const failureFingerprint = metadata?.failureFingerprint || (
      status === 'failed' || status === 'retry_failed'
        ? createFailureFingerprint(metadata?.error || metadata?.stderr || metadata?.stdout || activity.message)
        : undefined
    );
    let repeatedFailure = Boolean(metadata?.repeatedFailure);
    const normalizedCommand = normalizeCommand(command);

    if ((status === 'failed' || status === 'retry_failed') && normalizedCommand && failureFingerprint) {
      const key = `${normalizedCommand}\0${failureFingerprint}`;
      const firstFailure = firstFailureByCommandAndFingerprint.get(key);
      if (firstFailure && firstFailure.generation < attemptGeneration) {
        repeatedFailure = true;
        if (!repeatedFailures.some((failure) => (
          failure.command === normalizedCommand &&
          failure.failureFingerprint === failureFingerprint &&
          failure.generation === attemptGeneration
        ))) {
          repeatedFailures.push({
            command: normalizedCommand,
            generation: attemptGeneration,
            firstGeneration: firstFailure.generation,
            failureFingerprint,
          });
        }
      }
      if (!firstFailure) {
        firstFailureByCommandAndFingerprint.set(key, { generation: attemptGeneration });
      }
    }

    const patch: Partial<EnvironmentRecoveryAttempt> = {
      status,
      message: activity.message,
      command,
      generation: attemptGeneration,
      error: metadata?.error,
      failureFingerprint,
      repeatedFailure,
      stdout: metadata?.stdout,
      stderr: metadata?.stderr,
      suggestion: metadata?.suggestion,
      nextSuggestion: metadata?.nextSuggestion,
    };

    if (matchingAttempt) {
      Object.assign(matchingAttempt, patch);
    } else {
      attempts.push({
        id: activity.id,
        createdAt: activity.created_at,
        status,
        message: activity.message,
        command,
        generation: attemptGeneration,
        error: metadata?.error,
        failureFingerprint,
        repeatedFailure,
        stdout: metadata?.stdout,
        stderr: metadata?.stderr,
        suggestion: metadata?.suggestion,
        nextSuggestion: metadata?.nextSuggestion,
      });
    }

    if (status === 'completed') {
      generation = Math.max(generation, attemptGeneration + 1);
    }
  }

  const now = Date.now();
  for (const attempt of attempts) {
    if (attempt.status !== 'running') continue;
    const startedAtMs = new Date(attempt.createdAt).getTime();
    if (!Number.isFinite(startedAtMs) || now - startedAtMs > RUNNING_STALE_MS) {
      attempt.status = 'stale';
    }
  }

  const failedCommands = Array.from(new Set(
    attempts
      .filter((attempt) => (
        (attempt.status === 'failed' || attempt.status === 'retry_failed') &&
        attempt.generation === generation
      ))
      .map((attempt) => normalizeCommand(attempt.command))
      .filter((command): command is string => Boolean(command))
  ));
  const failedCommandSet = new Set(failedCommands);
  const latestNextSuggestion = [...attempts]
    .reverse()
    .filter((attempt) => attempt.generation === generation)
    .map((attempt) => attempt.nextSuggestion)
    .find((suggestion) => (
      suggestion?.canFixWithCommand &&
      suggestion.command &&
      !failedCommandSet.has(normalizeCommand(suggestion.command) || '')
    ));

  return {
    issue,
    running: Boolean(runningFix),
    runningFix: runningFix || undefined,
    attempts: attempts.reverse(),
    generation,
    failedCommands,
    repeatedFailures,
    nextSuggestion: latestNextSuggestion || null,
  };
}

function updateActivityMetadata(activityId: string, metadata: Record<string, unknown>) {
  run(
    `UPDATE task_activities
     SET metadata = ?
     WHERE id = ?`,
    [JSON.stringify(metadata), activityId]
  );
}

function hasFailedCommand(recovery: EnvironmentRecoveryState, command: string): boolean {
  const normalized = normalizeCommand(command);
  return Boolean(normalized && recovery.failedCommands.includes(normalized));
}

function updateTaskState(taskId: string, statusReason: string, planningError?: string | null): Task | null {
  if (planningError === undefined) {
    run(
      `UPDATE tasks
       SET status_reason = ?,
           updated_at = ?
       WHERE id = ?`,
      [statusReason, new Date().toISOString(), taskId]
    );
  } else {
    run(
      `UPDATE tasks
       SET planning_dispatch_error = ?,
           status_reason = ?,
           updated_at = ?
       WHERE id = ?`,
      [planningError, statusReason, new Date().toISOString(), taskId]
    );
  }

  const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (updatedTask) broadcast({ type: 'task_updated', payload: updatedTask });
  return updatedTask ?? null;
}

async function finishEnvironmentFix(
  runConfig: EnvironmentFixRun,
  error: ExecException | null,
  stdout: string | Buffer | undefined,
  stderr: string | Buffer | undefined
) {
  const { task, issue, suggestion, command, retry, generation } = runConfig;
  runningEnvironmentFixes.delete(task.id);

  if (error) {
    const message = formatCommandFailure(command, error, stdout, stderr);
    const failureFingerprint = createFailureFingerprint(message);
    const planningError = `Environment fix failed (${issue.code}): ${message}`;
    updateTaskState(
      task.id,
      `Environment fix failed: ${issue.title}`,
      planningError
    );

    const failureMetadata: EnvironmentFixMetadata = {
      issue,
      suggestion,
      command,
      error: message,
      failureFingerprint,
      generation,
    };
    const failureActivityId = recordActivity(
      task.id,
      task.assigned_agent_id,
      'environment_fix_failed',
      `Environment fix failed: ${issue.title}`,
      failureMetadata
    );

    try {
      const failedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [task.id]) || task;
      const contextActivities = getRecentContextActivities(task.id);
      const nextIssue = classifyEnvironmentIssueFromTexts(collectIssueText(failedTask, contextActivities, message)) || issue;
      const recovery = buildRecoveryState(task.id, nextIssue);
      const nextSuggestion = await suggestEnvironmentFixCommand({
        task: failedTask,
        issue: nextIssue,
        activities: contextActivities,
        requestText: message,
        blockedCommands: recovery.failedCommands,
      });

      if (nextSuggestion.canFixWithCommand && nextSuggestion.command) {
        updateActivityMetadata(failureActivityId, {
          ...failureMetadata,
          nextSuggestion,
        });
        updateTaskState(
          task.id,
          `Environment fix failed: ${nextIssue.title}. Suggested next action ready.`,
          planningError
        );
      } else if (recovery.repeatedFailures.some((failure) => (
        failure.command === normalizeCommand(command) &&
        failure.failureFingerprint === failureFingerprint &&
        failure.generation === generation
      ))) {
        updateTaskState(
          task.id,
          `Environment fix failed again with the same error: ${nextIssue.title}. Manual intervention needed.`,
          planningError
        );
      }
    } catch (suggestionError) {
      console.error('[Environment Fix] Failed to suggest next recovery action:', suggestionError);
    }
    return;
  }

  const stdoutText = compactOutput(stdout);
  const stderrText = compactOutput(stderr);
  recordActivity(task.id, task.assigned_agent_id, 'environment_fix_completed', `Environment fix completed: ${issue.title}`, {
    issue,
    suggestion,
    command,
    generation,
    stdout: stdoutText,
    stderr: stderrText,
  });

  updateTaskState(
    task.id,
    retry
      ? `Environment fix completed: ${issue.title}. Retrying assigned agent.`
      : `Environment fix completed: ${issue.title}.`,
    null
  );

  if (!retry) return;

  const retryResult = await dispatchTaskFromServer(task.id);
  if (!retryResult.success) {
    updateTaskState(
      task.id,
      `Environment fix completed: ${issue.title}, but retry failed.`,
      retryResult.error || 'Environment fixed, but retry failed.'
    );
    recordActivity(task.id, task.assigned_agent_id, 'environment_fix_retry_failed', `Environment fix retry failed: ${issue.title}`, {
      issue,
      suggestion,
      command,
      generation,
      error: retryResult.error || 'Environment fixed, but retry failed.',
      failureFingerprint: createFailureFingerprint(retryResult.error || 'Environment fixed, but retry failed.'),
    });
    return;
  }

  const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [task.id]);
  if (updatedTask) broadcast({ type: 'task_updated', payload: updatedTask });
}

function startEnvironmentFix(runConfig: EnvironmentFixRun): { command: string; startedAt: string } {
  const startedAt = new Date().toISOString();
  const { task, issue, suggestion, command, commandSource, generation } = runConfig;
  runningEnvironmentFixes.set(task.id, { command, startedAt });

  recordActivity(task.id, task.assigned_agent_id, 'environment_fix_started', `Running approved environment command: ${command}`, {
    issue,
    suggestion,
    command,
    commandSource,
    generation,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });

  updateTaskState(task.id, `Environment fix running: ${issue.title}`);

  exec(
    command,
    {
      cwd: task.workspace_path || undefined,
      timeout: COMMAND_TIMEOUT_MS,
      killSignal: 'SIGTERM',
      maxBuffer: 1024 * 1024 * 8,
      env: process.env,
    },
    (error, stdout, stderr) => {
      void finishEnvironmentFix(runConfig, error, stdout, stderr).catch((finishError) => {
        runningEnvironmentFixes.delete(task.id);
        console.error('[Environment Fix] Failed to finish background command:', finishError);
      });
    }
  );

  return { command, startedAt };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const activities = getRecentContextActivities(taskId);
    const issue = classifyEnvironmentIssueFromTexts(collectIssueText(task, activities));
    if (!issue) {
      return NextResponse.json({
        success: true,
        issue: null,
        recovery: null,
        task,
      });
    }

    return NextResponse.json({
      success: true,
      issue,
      recovery: buildRecoveryState(taskId, issue),
      task,
    });
  } catch (error) {
    console.error('[Environment Fix] Failed to load recovery state:', error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Failed to load environment recovery state',
    }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const body = await request.json().catch(() => ({} as {
      code?: EnvironmentIssueCode;
      retry?: boolean;
      reason?: string;
      approvedCommand?: string;
      userProvidedCommand?: boolean;
      autoSuggestCommand?: boolean;
      suggestOnly?: boolean;
    }));
    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    if (task.status === 'done') {
      return NextResponse.json({ error: 'Completed tasks cannot be retried.' }, { status: 409 });
    }

    const activities = getRecentContextActivities(taskId);
    const issue = classifyEnvironmentIssueFromTexts(collectIssueText(task, activities, body.reason));

    if (!issue) {
      return NextResponse.json({
        error: 'No known environment issue is currently recorded for this task.',
      }, { status: 400 });
    }

    if (body.code && body.code !== issue.code) {
      return NextResponse.json({
        error: `Recorded issue is ${issue.code}, not ${body.code}. Refresh the task and try again.`,
        issue,
      }, { status: 409 });
    }

    let recovery = buildRecoveryState(taskId, issue);
    const runningFix = recovery.runningFix;
    if (runningFix) {
      const runningTask = task.status_reason?.toLowerCase().startsWith('environment fix running:')
        ? task
        : updateTaskState(taskId, `Environment fix running: ${issue.title}`);

      return NextResponse.json({
        success: true,
        running: true,
        fixed: false,
        retried: false,
        issue,
        suggestion: null,
        fix: { command: runningFix.command, startedAt: runningFix.startedAt },
        recovery,
        task: runningTask,
      }, { status: 202 });
    }

    const approvedCommand = body.approvedCommand?.trim();
    let commandToRun = approvedCommand;
    let commandSource = hasEnvironmentIssueCommand(issue) ? issue.action.commandSource || 'detected' : 'user_input';
    let suggestion: EnvironmentCommandSuggestion | null = null;

    if (!commandToRun && body.autoSuggestCommand) {
      try {
        suggestion = await suggestEnvironmentFixCommand({
          task,
          issue,
          activities,
          requestText: body.reason,
          blockedCommands: recovery.failedCommands,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to suggest an environment command';
        return NextResponse.json({
          error: `Could not determine a setup command: ${message}`,
          issue,
        }, { status: 502 });
      }

      if (suggestion.command) {
        commandToRun = suggestion.command;
        commandSource = 'agent_suggestion';
      }
    }

    if (body.suggestOnly) {
      const suggestedRecovery = suggestion?.canFixWithCommand && suggestion.command
        ? { ...recovery, nextSuggestion: suggestion }
        : recovery;

      if (!suggestion?.canFixWithCommand || !suggestion.command) {
        return NextResponse.json({
          success: false,
          error: suggestion?.rationale || 'Mission Control could not determine a new setup command to run.',
          issue,
          suggestion,
          recovery: suggestedRecovery,
        }, { status: 409 });
      }

      return NextResponse.json({
        success: true,
        issue,
        suggestion,
        recovery: suggestedRecovery,
        task,
      });
    }

    if (!commandToRun) {
      return NextResponse.json({
        error: 'Mission Control could not determine a setup command to run.',
        issue,
        suggestion,
        recovery,
      }, { status: 409 });
    }

    if (!body.userProvidedCommand && hasFailedCommand(recovery, commandToRun)) {
      return NextResponse.json({
        error: 'That exact command already failed for this task. Review the recovery history or approve a different command.',
        issue,
        suggestion,
        recovery,
      }, { status: 409 });
    }

    if (approvedCommand && hasEnvironmentIssueCommand(issue) && !body.userProvidedCommand && approvedCommand !== issue.action.command) {
      return NextResponse.json({
        error: 'The command must be explicitly approved and must match the command shown in the UI.',
        issue,
      }, { status: 409 });
    }

    if (!hasEnvironmentIssueCommand(issue) && !body.userProvidedCommand && !body.autoSuggestCommand) {
      return NextResponse.json({
        error: 'Manual environment fixes require a user-provided or agent-suggested command.',
        issue,
      }, { status: 409 });
    }

    const fixRun = startEnvironmentFix({
      task,
      issue,
      suggestion,
      command: commandToRun,
      commandSource,
      retry: body.retry !== false,
      generation: recovery.generation,
    });
    const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    recovery = buildRecoveryState(taskId, issue);

    return NextResponse.json({
      success: true,
      running: true,
      started: true,
      fixed: false,
      retried: false,
      issue,
      suggestion,
      fix: fixRun,
      recovery,
      task: updatedTask,
    }, { status: 202 });
  } catch (error) {
    console.error('[Environment Fix] Failed:', error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Environment fix failed',
    }, { status: 500 });
  }
}
