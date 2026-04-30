'use client';

import { useEffect, useState, type MouseEvent } from 'react';
import { AlertTriangle, CheckCircle2, Clipboard, ExternalLink, History, RefreshCw, Wrench } from 'lucide-react';
import { classifyEnvironmentIssueFromTexts, type EnvironmentIssue } from '@/lib/environment-issues';
import { useMissionControl } from '@/lib/store';
import type { Task } from '@/lib/types';

interface EnvironmentIssuePanelProps {
  task: Task;
  compact?: boolean;
  className?: string;
}

interface TaskActionResponse {
  success?: boolean;
  error?: string;
  userMessage?: string;
  task?: Task;
  issue?: EnvironmentIssue;
  recovery?: EnvironmentRecoveryState | null;
  running?: boolean;
  started?: boolean;
  fixed?: boolean;
  retried?: boolean;
  fix?: { command?: string; startedAt?: string };
  suggestion?: { command?: string; rationale?: string };
}

interface EnvironmentRecoverySuggestion {
  canFixWithCommand?: boolean;
  command?: string;
  rationale?: string;
  confidence?: 'low' | 'medium' | 'high';
}

interface EnvironmentRecoveryAttempt {
  id: string;
  createdAt: string;
  status: 'running' | 'failed' | 'completed' | 'retry_failed' | 'stale';
  command?: string;
  commandSource?: string;
  generation: number;
  message: string;
  error?: string;
  failureFingerprint?: string;
  repeatedFailure?: boolean;
  stdout?: string;
  stderr?: string;
  suggestion?: EnvironmentRecoverySuggestion | null;
  nextSuggestion?: EnvironmentRecoverySuggestion | null;
}

interface EnvironmentRecoveryState {
  running: boolean;
  runningFix?: { command: string; startedAt: string };
  attempts: EnvironmentRecoveryAttempt[];
  generation: number;
  failedCommands: string[];
  repeatedFailures: Array<{ command: string; generation: number; firstGeneration: number; failureFingerprint: string }>;
  nextSuggestion?: EnvironmentRecoverySuggestion | null;
}

export function getTaskEnvironmentIssue(task: Task): EnvironmentIssue | null {
  return classifyEnvironmentIssueFromTexts([
    task.status_reason,
    task.planning_dispatch_error,
  ]);
}

function summarizeText(text: string | undefined, maxLength = 180): string | null {
  if (!text) return null;
  const line = text
    .split(/\r?\n/)
    .map(part => part.trim())
    .find(Boolean);
  if (!line) return null;
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}...` : line;
}

function attemptStatusLabel(status: EnvironmentRecoveryAttempt['status']): string {
  if (status === 'retry_failed') return 'Retry failed';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function EnvironmentIssuePanel({ task, compact = false, className = '' }: EnvironmentIssuePanelProps) {
  const updateTask = useMissionControl((state) => state.updateTask);
  const issue = getTaskEnvironmentIssue(task);
  const [isFixing, setIsFixing] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isConfirmingCommand, setIsConfirmingCommand] = useState(false);
  const [isEnteringCommand, setIsEnteringCommand] = useState(false);
  const [userCommand, setUserCommand] = useState('');
  const [recovery, setRecovery] = useState<EnvironmentRecoveryState | null>(null);
  const issueCode = issue?.code;

  useEffect(() => {
    let cancelled = false;

    if (!issueCode) {
      setRecovery(null);
      return;
    }

    fetch(`/api/tasks/${task.id}/environment/fix`)
      .then((res) => res.json())
      .then((data: TaskActionResponse) => {
        if (cancelled) return;
        setRecovery(data.recovery || null);
        if (data.task) updateTask(data.task);
      })
      .catch(() => {
        if (!cancelled) setRecovery(null);
      });

    return () => {
      cancelled = true;
    };
  }, [issueCode, task.id, task.updated_at, updateTask]);

  if (!issue) return null;

  const fixStartedAt = task.updated_at ? new Date(task.updated_at).getTime() : NaN;
  const fixIsFresh = Number.isFinite(fixStartedAt) && Date.now() - fixStartedAt < 11 * 60 * 1000;
  const fixIsRunning = Boolean(recovery?.running) || ((task.status_reason?.toLowerCase().startsWith('environment fix running:') ?? false) && fixIsFresh);
  const suggestedCommand = recovery?.nextSuggestion?.command || issue.action.command;
  const approvedCommand = userCommand.trim() || suggestedCommand || '';
  const recentAttempts = recovery?.attempts.slice(0, 3) || [];
  const approvedCommandSource = userCommand.trim()
    ? recovery?.nextSuggestion?.command === userCommand.trim()
      ? 'Recovery analysis'
      : 'User input'
    : recovery?.nextSuggestion?.command
      ? 'Recovery analysis'
      : issue.action.commandSource || 'Detected issue';
  const approvedCommandRationale = recovery?.nextSuggestion?.command === approvedCommand
    ? recovery.nextSuggestion.rationale
    : undefined;
  const repeatedFailure = recovery?.repeatedFailures?.[0];

  const stop = (event: MouseEvent) => {
    event.stopPropagation();
  };

  const applyResponse = (data: TaskActionResponse) => {
    if (data.task) updateTask(data.task);
    if (data.recovery !== undefined) setRecovery(data.recovery);
  };

  const handleCopyCommand = async (event: MouseEvent) => {
    stop(event);
    if (!suggestedCommand) return;

    try {
      await navigator.clipboard.writeText(suggestedCommand);
      setCopied(true);
      setMessage('Command copied.');
      setError(null);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy command. Select it manually.');
    }
  };

  const handleRetry = async (event: MouseEvent) => {
    stop(event);
    if (fixIsRunning) {
      setMessage('Environment fix is still running. The agent will retry automatically if it succeeds.');
      return;
    }
    setIsRetrying(true);
    setError(null);
    setMessage(null);

    try {
      const res = await fetch(`/api/tasks/${task.id}/dispatch/retry`, { method: 'POST' });
      const data = await res.json().catch(() => ({} as TaskActionResponse));
      applyResponse(data);

      if (!res.ok || !data.success) {
        setError(data.userMessage || data.error || 'Retry failed.');
        return;
      }

      setMessage('Agent retry started.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retry failed.');
    } finally {
      setIsRetrying(false);
    }
  };

  const handleRunFix = async (event: MouseEvent) => {
    stop(event);
    if (fixIsRunning) {
      setMessage('Environment fix is already running.');
      return;
    }
    if (!approvedCommand) {
      setError('Enter a command first.');
      return;
    }
    setIsFixing(true);
    setIsConfirmingCommand(false);
    setIsEnteringCommand(false);
    setError(null);
    setMessage(null);

    try {
      const res = await fetch(`/api/tasks/${task.id}/environment/fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: issue.code,
          retry: true,
          approvedCommand,
          userProvidedCommand: approvedCommand !== issue.action.command,
        }),
      });
      const data = await res.json().catch(() => ({} as TaskActionResponse));
      applyResponse(data);

      if (!res.ok || !data.success) {
        setError(data.error || 'Environment fix failed.');
        return;
      }

      if (data.running) {
        const command = data.fix?.command ? ` Running: ${data.fix.command}` : '';
        setMessage(`Environment fix started.${command} The agent will retry automatically if it succeeds.`);
      } else {
        setMessage(data.retried ? 'Fix ran and agent retry started.' : 'Fix ran successfully.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Environment fix failed.');
    } finally {
      setIsFixing(false);
    }
  };

  const handleAutoFix = async (event: MouseEvent) => {
    stop(event);
    if (fixIsRunning) {
      setMessage('Environment fix is already running.');
      return;
    }
    setIsFixing(true);
    setIsConfirmingCommand(false);
    setIsEnteringCommand(false);
    setError(null);
    setMessage(null);

    try {
      const res = await fetch(`/api/tasks/${task.id}/environment/fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: issue.code,
          retry: true,
          autoSuggestCommand: true,
          suggestOnly: true,
        }),
      });
      const data = await res.json().catch(() => ({} as TaskActionResponse));
      applyResponse(data);

      if (!res.ok || !data.success) {
        if (data.suggestion?.command) {
          setUserCommand(data.suggestion.command);
          setIsConfirmingCommand(true);
        }
        setError(data.error || 'Auto fix failed.');
        return;
      }

      if (data.suggestion?.command) {
        setUserCommand(data.suggestion.command);
        setIsConfirmingCommand(true);
        setMessage('Review the suggested command before running it.');
      } else {
        setMessage('No command suggestion is available yet.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Auto fix failed.');
    } finally {
      setIsFixing(false);
    }
  };

  const tone = issue.severity === 'danger'
    ? 'bg-red-500/10 border-red-500/30 text-red-200'
    : 'bg-amber-500/10 border-amber-500/30 text-amber-100';
  const iconTone = issue.severity === 'danger' ? 'text-red-300' : 'text-amber-300';

  return (
    <div className={`${compact ? 'p-2.5' : 'p-3'} rounded-md border ${tone} ${className}`}>
      <div className="flex items-start gap-2">
        <AlertTriangle className={`w-4 h-4 mt-0.5 flex-shrink-0 ${iconTone}`} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold">Environment action required</div>
          <div className={`${compact ? 'text-[11px] line-clamp-2' : 'text-xs'} mt-1 opacity-90`}>
            {issue.summary} Mission Control paused the agent loop so this is not treated as a code bug.
          </div>
        </div>
      </div>

      {!compact && (
        <div className="mt-2 text-xs opacity-80">
          {fixIsRunning
            ? 'Mission Control is running the approved setup command. The assigned agent will retry automatically if it succeeds.'
            : issue.userMessage}
        </div>
      )}

      {!compact && recovery?.nextSuggestion?.command && (
        <div className="mt-3 rounded-md border border-white/15 bg-black/20 p-2.5">
          <div className="text-[11px] font-semibold uppercase opacity-70">Next suggested action</div>
          <code className="mt-1 block rounded border border-white/15 bg-black/30 px-2 py-1 text-[11px] break-all">
            {recovery.nextSuggestion.command}
          </code>
          {recovery.nextSuggestion.rationale && (
            <div className="mt-1 text-[11px] opacity-75">
              {recovery.nextSuggestion.rationale}
            </div>
          )}
        </div>
      )}

      {!compact && repeatedFailure && !recovery?.nextSuggestion?.command && (
        <div className="mt-3 rounded-md border border-red-400/25 bg-red-500/10 p-2.5">
          <div className="text-[11px] font-semibold uppercase text-red-100/80">Manual intervention needed</div>
          <div className="mt-1 text-[11px] opacity-80">
            The same command failed with the same error after a successful recovery step. Mission Control will not keep suggesting it automatically.
          </div>
          <code className="mt-2 block rounded border border-white/15 bg-black/30 px-2 py-1 text-[11px] break-all">
            {repeatedFailure.command}
          </code>
        </div>
      )}

      {!compact && recentAttempts.length > 0 && (
        <div className="mt-3 rounded-md border border-white/15 bg-black/15 p-2.5">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase opacity-70">
            <History className="w-3.5 h-3.5" />
            Recovery history
          </div>
          <div className="mt-2 space-y-2">
            {recentAttempts.map((attempt) => {
              const detail = summarizeText(attempt.error || attempt.stderr || attempt.stdout || attempt.message);
              return (
                <div key={attempt.id} className="border-t border-white/10 pt-2 first:border-t-0 first:pt-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                    <span className="font-semibold">{attemptStatusLabel(attempt.status)}</span>
                    <span className="opacity-60">Gen {attempt.generation}</span>
                    {attempt.repeatedFailure && <span className="text-red-100/80">same error repeated</span>}
                    <span className="opacity-60">{new Date(attempt.createdAt).toLocaleTimeString()}</span>
                  </div>
                  {attempt.command && (
                    <code className="mt-1 block break-all text-[10px] opacity-80">{attempt.command}</code>
                  )}
                  {detail && (
                    <div className="mt-1 text-[10px] opacity-70">{detail}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {suggestedCommand && !compact && !recovery?.nextSuggestion?.command && (
        <code className="mt-2 block rounded border border-white/15 bg-black/20 px-2 py-1 text-[11px] break-all opacity-90">
          {suggestedCommand}
        </code>
      )}

      <div className={`mt-2 flex ${compact ? 'flex-col' : 'flex-wrap'} gap-2`}>
        {suggestedCommand && (
          <button
            type="button"
            onClick={(event) => {
              stop(event);
              setUserCommand(suggestedCommand);
              setIsConfirmingCommand(true);
              setIsEnteringCommand(false);
              setError(null);
              setMessage(null);
            }}
            disabled={isFixing || isRetrying || fixIsRunning}
            className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded border border-white/20 bg-white/10 px-2.5 text-[11px] font-medium hover:bg-white/20 disabled:opacity-50"
          >
            <Wrench className={`w-3.5 h-3.5 ${fixIsRunning || isFixing ? 'animate-spin' : ''}`} />
            {fixIsRunning ? 'Fix running...' : isFixing ? 'Running command...' : 'Review suggested fix'}
          </button>
        )}

        {issue.action.mode === 'manual' && !suggestedCommand && (
          <button
            type="button"
            onClick={handleAutoFix}
            disabled={isFixing || isRetrying || fixIsRunning}
            className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded border border-white/20 bg-white/10 px-2.5 text-[11px] font-medium hover:bg-white/20 disabled:opacity-50"
          >
            <Wrench className={`w-3.5 h-3.5 ${fixIsRunning || isFixing ? 'animate-spin' : ''}`} />
            {fixIsRunning ? 'Fix running...' : isFixing ? 'Finding command...' : 'Find fix command'}
          </button>
        )}

        {issue.action.mode === 'manual' && !suggestedCommand && (
          <button
            type="button"
            onClick={(event) => {
              stop(event);
              setIsEnteringCommand(true);
              setIsConfirmingCommand(false);
              setError(null);
              setMessage(null);
            }}
            disabled={isFixing || isRetrying || fixIsRunning}
            className="inline-flex min-h-9 items-center justify-center rounded border border-white/15 px-2.5 text-[11px] hover:bg-white/10 disabled:opacity-50"
          >
            Enter command
          </button>
        )}

        {issue.action.mode === 'settings' && issue.action.settingsHref && (
          <a
            href={issue.action.settingsHref}
            onClick={stop}
            className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded border border-white/20 bg-white/10 px-2.5 text-[11px] font-medium hover:bg-white/20"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            {issue.action.label}
          </a>
        )}

        {suggestedCommand && (
          <button
            type="button"
            onClick={handleCopyCommand}
            className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded border border-white/15 px-2.5 text-[11px] hover:bg-white/10"
          >
            {copied ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Clipboard className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : compact ? 'Copy fix' : 'Copy command'}
          </button>
        )}

        <button
          type="button"
          onClick={handleRetry}
          disabled={isFixing || isRetrying || fixIsRunning}
          className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded border border-white/15 px-2.5 text-[11px] hover:bg-white/10 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isRetrying ? 'animate-spin' : ''}`} />
          {isRetrying ? 'Retrying...' : issue.retryLabel}
        </button>
      </div>

      {(message || error) && (
        <div className={`mt-2 text-[11px] ${error ? 'text-red-200' : 'text-green-200'}`}>
          {error || message}
        </div>
      )}

      {isEnteringCommand && !suggestedCommand && (
        <div
          className="mt-3 rounded-md border border-white/20 bg-black/25 p-3"
          onClick={(event) => event.stopPropagation()}
        >
          <label className="text-xs font-semibold" htmlFor={`environment-command-${task.id}`}>
            Setup command
          </label>
          <textarea
            id={`environment-command-${task.id}`}
            value={userCommand}
            onChange={(event) => setUserCommand(event.target.value)}
            rows={compact ? 2 : 3}
            className="mt-2 w-full rounded border border-white/15 bg-black/30 px-2 py-1.5 text-[11px] text-white outline-none focus:border-white/35"
            placeholder="Paste the command to run"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={(event) => {
                stop(event);
                if (!userCommand.trim()) {
                  setError('Enter a command first.');
                  return;
                }
                setError(null);
                setIsEnteringCommand(false);
                setIsConfirmingCommand(true);
              }}
              disabled={isFixing || isRetrying || fixIsRunning}
              className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded bg-white/15 px-2.5 text-[11px] font-medium hover:bg-white/20 disabled:opacity-50"
            >
              <Wrench className="w-3.5 h-3.5" />
              Review command
            </button>
            <button
              type="button"
              onClick={(event) => {
                stop(event);
                setIsEnteringCommand(false);
              }}
              className="inline-flex min-h-9 items-center justify-center rounded border border-white/15 px-2.5 text-[11px] hover:bg-white/10"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {isConfirmingCommand && approvedCommand && (
        <div
          className="mt-3 rounded-md border border-white/20 bg-black/25 p-3"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="text-xs font-semibold">Approve command</div>
          <div className="mt-1 text-[11px] opacity-80">
            Mission Control will run this exact command on this machine, then retry the assigned agent.
          </div>
          <code className="mt-2 block rounded border border-white/15 bg-black/30 px-2 py-1 text-[11px] break-all">
            {approvedCommand}
          </code>
          <div className="mt-1 text-[10px] opacity-70">
            Source: {approvedCommandSource}
          </div>
          {approvedCommandRationale && (
            <div className="mt-1 text-[10px] opacity-70">
              {approvedCommandRationale}
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={handleRunFix}
              disabled={isFixing || isRetrying || fixIsRunning}
              className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded bg-white/15 px-2.5 text-[11px] font-medium hover:bg-white/20 disabled:opacity-50"
            >
              <Wrench className="w-3.5 h-3.5" />
              Run command
            </button>
            <button
              type="button"
              onClick={(event) => {
                stop(event);
                setIsConfirmingCommand(false);
              }}
              className="inline-flex min-h-9 items-center justify-center rounded border border-white/15 px-2.5 text-[11px] hover:bg-white/10"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
