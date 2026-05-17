import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { CODEX_COMMAND } from '@/lib/codex/status';
import type { Agent, CodexSession, Task } from '@/lib/types';

const CODEX_DISPATCH_SANDBOX = process.env.CODEX_DISPATCH_SANDBOX || 'danger-full-access';
const CODEX_ENV_PASSTHROUGH = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'SSH_AUTH_SOCK',
  'CODEX_HOME',
  'XDG_CONFIG_HOME',
];

interface StartCodexTaskRunInput {
  task: Task;
  agent: Agent;
  prompt: string;
  workingDirectory: string;
  env?: Record<string, string | undefined>;
}

export interface StartedCodexTaskRun {
  sessionId: string;
  pid?: number;
  command: string;
  cwd: string;
  logPath: string;
}

function expandPath(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function ensureDirectory(input: string): string {
  const resolved = path.resolve(expandPath(input));
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function createLogPath(taskId: string, sessionId: string): string {
  const logDir = path.join(process.cwd(), '.codex-runs', taskId);
  fs.mkdirSync(logDir, { recursive: true });
  return path.join(logDir, `${sessionId}.log`);
}

function buildCodexEnvironment(extraEnv?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: Record<string, string> = {
    NODE_ENV: process.env.NODE_ENV || 'production',
  };

  for (const key of CODEX_ENV_PASSTHROUGH) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }

  if (process.env.MC_API_TOKEN) {
    env.MC_API_TOKEN = process.env.MC_API_TOKEN;
  }

  for (const [key, value] of Object.entries(extraEnv || {})) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  env.NO_COLOR = '1';
  return env as NodeJS.ProcessEnv;
}

function recordActivity(taskId: string, agentId: string, message: string, metadata?: Record<string, unknown>): void {
  run(
    `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
     VALUES (?, ?, ?, 'status_changed', ?, ?, ?)`,
    [uuidv4(), taskId, agentId, message, metadata ? JSON.stringify(metadata) : null, new Date().toISOString()]
  );
}

function updateTaskFailure(taskId: string, message: string): void {
  const now = new Date().toISOString();
  run(
    `UPDATE tasks
     SET status = CASE WHEN status = 'in_progress' THEN 'assigned' ELSE status END,
         planning_dispatch_error = ?,
         status_reason = ?,
         updated_at = ?
     WHERE id = ?
       AND status != 'done'`,
    [message, message, now, taskId]
  );

  const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (updatedTask) {
    broadcast({ type: 'task_updated', payload: updatedTask });
  }
}

function parseCodexEventLine(line: string): { threadId?: string; finalMessage?: string } | undefined {
  try {
    const event = JSON.parse(line) as {
      type?: string;
      thread_id?: string;
      item?: { type?: string; text?: string };
    };

    if (event.type === 'thread.started' && event.thread_id) {
      return { threadId: event.thread_id };
    }

    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
      return { finalMessage: event.item.text };
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function handleCodexStdout(sessionId: string, chunk: Buffer, state: { buffer: string; finalMessage?: string }): void {
  state.buffer += chunk.toString('utf8');
  const lines = state.buffer.split(/\r?\n/);
  state.buffer = lines.pop() || '';

  for (const line of lines) {
    const parsed = parseCodexEventLine(line.trim());
    if (!parsed) continue;

    if (parsed.threadId) {
      run('UPDATE codex_sessions SET codex_thread_id = ?, updated_at = ? WHERE id = ?', [
        parsed.threadId,
        new Date().toISOString(),
        sessionId,
      ]);
    }

    if (parsed.finalMessage) {
      state.finalMessage = parsed.finalMessage;
    }
  }
}

export function startCodexTaskRun(input: StartCodexTaskRunInput): StartedCodexTaskRun {
  const sessionId = uuidv4();
  const cwd = ensureDirectory(input.workingDirectory);
  const logPath = createLogPath(input.task.id, sessionId);
  const args = ['exec', '--sandbox', CODEX_DISPATCH_SANDBOX, '--json', '--skip-git-repo-check', '--cd', cwd, '-'];
  const command = `${CODEX_COMMAND} ${args.join(' ')}`;
  const now = new Date().toISOString();

  const child = spawn(CODEX_COMMAND, args, {
    cwd,
    env: buildCodexEnvironment(input.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  run(
    `INSERT INTO codex_sessions (id, agent_id, task_id, pid, status, command, cwd, log_path, started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`,
    [sessionId, input.agent.id, input.task.id, child.pid || null, command, cwd, logPath, now, now, now]
  );

  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  const stdoutState: { buffer: string; finalMessage?: string } = { buffer: '' };
  let stderrTail = '';

  child.stdout.on('data', (chunk: Buffer) => {
    logStream.write(chunk);
    handleCodexStdout(sessionId, chunk, stdoutState);
  });

  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    logStream.write(chunk);
    stderrTail = (stderrTail + text).slice(-4000);
  });

  child.on('error', (error) => {
    const endedAt = new Date().toISOString();
    const message = `Codex run failed to start: ${error.message}`;

    run(
      `UPDATE codex_sessions
       SET status = 'failed', error = ?, ended_at = ?, updated_at = ?
       WHERE id = ?`,
      [message, endedAt, endedAt, sessionId]
    );

    recordActivity(input.task.id, input.agent.id, message, { runtime: 'codex', session_id: sessionId, log_path: logPath });
    updateTaskFailure(input.task.id, message);
    logStream.end();
  });

  child.on('close', (code, signal) => {
    const endedAt = new Date().toISOString();
    const failed = code !== 0 || Boolean(signal);
    const status = failed ? 'failed' : 'completed';
    const error = failed
      ? `Codex run exited with ${signal ? `signal ${signal}` : `code ${code}`}${stderrTail.trim() ? `: ${stderrTail.trim()}` : ''}`
      : null;

    run(
      `UPDATE codex_sessions
       SET status = ?, exit_code = ?, signal = ?, error = ?, ended_at = ?, updated_at = ?
       WHERE id = ?`,
      [status, code, signal, error, endedAt, endedAt, sessionId]
    );

    recordActivity(
      input.task.id,
      input.agent.id,
      failed ? `Codex run failed: ${error}` : 'Codex run completed',
      {
        runtime: 'codex',
        session_id: sessionId,
        log_path: logPath,
        final_message: stdoutState.finalMessage,
      }
    );

    if (failed && error) {
      updateTaskFailure(input.task.id, error);
    }

    logStream.end();
  });

  child.stdin.end(input.prompt);

  return {
    sessionId,
    pid: child.pid,
    command,
    cwd,
    logPath,
  };
}

export function getActiveCodexSessions(agentId: string, taskId: string): CodexSession[] {
  return queryAll<CodexSession>(
    `SELECT * FROM codex_sessions
     WHERE agent_id = ?
       AND task_id = ?
       AND status = 'running'
     ORDER BY created_at DESC`,
    [agentId, taskId]
  );
}

export function cancelCodexRunsForTask(taskId: string, agentId?: string): number {
  const sessions = agentId
    ? queryAll<CodexSession>(
      `SELECT * FROM codex_sessions WHERE task_id = ? AND agent_id = ? AND status = 'running'`,
      [taskId, agentId]
    )
    : queryAll<CodexSession>(
      `SELECT * FROM codex_sessions WHERE task_id = ? AND status = 'running'`,
      [taskId]
    );

  for (const session of sessions) {
    if (session.pid) {
      try {
        process.kill(session.pid, 'SIGTERM');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH') {
          console.warn('[Codex] Failed to terminate prior run:', error);
        }
      }
    }
  }

  const now = new Date().toISOString();
  const result = agentId
    ? run(
      `UPDATE codex_sessions
       SET status = 'cancelled', error = ?, ended_at = ?, updated_at = ?
       WHERE task_id = ? AND agent_id = ? AND status = 'running'`,
      ['Cancelled before replacement dispatch', now, now, taskId, agentId]
    )
    : run(
      `UPDATE codex_sessions
       SET status = 'cancelled', error = ?, ended_at = ?, updated_at = ?
       WHERE task_id = ? AND status = 'running'`,
      ['Cancelled before replacement dispatch', now, now, taskId]
    );

  return result.changes;
}
