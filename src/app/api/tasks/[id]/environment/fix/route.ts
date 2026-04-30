import { exec } from 'child_process';
import { promisify } from 'util';
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
  type EnvironmentIssueCode,
} from '@/lib/environment-issues';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';

const execAsync = promisify(exec);
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_CHARS = 6000;

interface RecentActivity {
  created_at?: string;
  activity_type?: string;
  message: string;
  metadata?: string | null;
}

function compactOutput(value: string | Buffer | undefined): string {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : value || '';
  return text.length > MAX_OUTPUT_CHARS ? text.slice(-MAX_OUTPUT_CHARS) : text;
}

async function runCommand(command: string, cwd?: string) {
  try {
    const result = await execAsync(command, {
      cwd,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 8,
      env: process.env,
    });

    return {
      stdout: compactOutput(result.stdout),
      stderr: compactOutput(result.stderr),
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string | Buffer; stderr?: string | Buffer };
    const stderr = compactOutput(err.stderr);
    const stdout = compactOutput(err.stdout);
    const detail = [stderr, stdout, err.message].filter(Boolean).join('\n').trim();
    throw new Error(detail || `Command failed: ${command}`);
  }
}

async function runEnvironmentFix(task: Task, approvedCommand: string) {
  const result = await runCommand(approvedCommand, task.workspace_path || undefined);
  return {
    command: approvedCommand,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function collectIssueText(task: Task, activities: RecentActivity[], requestText?: string): Array<string | null | undefined> {
  return [
    requestText,
    task.status_reason,
    task.planning_dispatch_error,
    ...activities.flatMap((activity) => [activity.message, activity.metadata || undefined]),
  ];
}

function recordActivity(taskId: string, agentId: string | null, type: string, message: string, metadata?: Record<string, unknown>) {
  run(
    `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), taskId, agentId, type, message, metadata ? JSON.stringify(metadata) : null, new Date().toISOString()]
  );
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
    }));
    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    if (task.status === 'done') {
      return NextResponse.json({ error: 'Completed tasks cannot be retried.' }, { status: 409 });
    }

    const activities = queryAll<RecentActivity>(
      `SELECT created_at, activity_type, message, metadata
       FROM task_activities
       WHERE task_id = ?
         AND activity_type IN ('environment_blocked', 'status_changed')
       ORDER BY created_at DESC
       LIMIT 10`,
      [taskId]
    );
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

    if (!commandToRun) {
      return NextResponse.json({
        error: 'Mission Control could not determine a setup command to run.',
        issue,
        suggestion,
      }, { status: 409 });
    }

    if (approvedCommand && hasEnvironmentIssueCommand(issue) && approvedCommand !== issue.action.command) {
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

    recordActivity(taskId, task.assigned_agent_id, 'environment_fix_started', `Running approved environment command: ${commandToRun}`, {
      issue,
      suggestion,
      commandSource,
    });

    let fixResult: Awaited<ReturnType<typeof runEnvironmentFix>>;
    try {
      fixResult = await runEnvironmentFix(task, commandToRun);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Environment fix failed';
      run(
        `UPDATE tasks
         SET planning_dispatch_error = ?,
             status_reason = ?,
             updated_at = ?
         WHERE id = ?`,
        [`Environment fix failed (${issue.code}): ${message}`, `Environment fix failed: ${issue.title}`, new Date().toISOString(), taskId]
      );
      recordActivity(taskId, task.assigned_agent_id, 'environment_fix_failed', `Environment fix failed: ${issue.title}`, {
        issue,
        suggestion,
        error: message,
      });

      const failedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
      if (failedTask) broadcast({ type: 'task_updated', payload: failedTask });

      return NextResponse.json({
        success: false,
        fixed: false,
        issue,
        suggestion,
        error: message,
        task: failedTask,
      }, { status: 500 });
    }

    recordActivity(taskId, task.assigned_agent_id, 'environment_fix_completed', `Environment fix completed: ${issue.title}`, {
      issue,
      suggestion,
      command: fixResult.command,
      stdout: fixResult.stdout,
      stderr: fixResult.stderr,
    });

    run(
      `UPDATE tasks
       SET planning_dispatch_error = NULL,
           status_reason = ?,
           updated_at = ?
       WHERE id = ?`,
      [`Environment fix completed: ${issue.title}. Retrying assigned agent.`, new Date().toISOString(), taskId]
    );

    let retryResult: Awaited<ReturnType<typeof dispatchTaskFromServer>> | null = null;
    if (body.retry !== false) {
      retryResult = await dispatchTaskFromServer(taskId);
    }

    const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (updatedTask) {
      broadcast({ type: 'task_updated', payload: updatedTask });
    }

    if (retryResult && !retryResult.success) {
      return NextResponse.json({
        success: false,
        fixed: true,
        retried: false,
        issue,
        suggestion,
        fix: fixResult,
        error: retryResult.error || 'Environment fixed, but retry failed.',
        task: updatedTask,
      }, { status: retryResult.status || 502 });
    }

    return NextResponse.json({
      success: true,
      fixed: true,
      retried: body.retry !== false,
      issue,
      suggestion,
      fix: fixResult,
      retry: retryResult,
      task: updatedTask,
    });
  } catch (error) {
    console.error('[Environment Fix] Failed:', error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Environment fix failed',
    }, { status: 500 });
  }
}
