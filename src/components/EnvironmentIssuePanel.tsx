'use client';

import { useState, type MouseEvent } from 'react';
import { AlertTriangle, CheckCircle2, Clipboard, ExternalLink, RefreshCw, Wrench } from 'lucide-react';
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
  fixed?: boolean;
  retried?: boolean;
  fix?: { command?: string };
  suggestion?: { command?: string; rationale?: string };
}

export function getTaskEnvironmentIssue(task: Task): EnvironmentIssue | null {
  return classifyEnvironmentIssueFromTexts([
    task.status_reason,
    task.planning_dispatch_error,
  ]);
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

  if (!issue) return null;

  const stop = (event: MouseEvent) => {
    event.stopPropagation();
  };

  const applyResponse = (data: TaskActionResponse) => {
    if (data.task) updateTask(data.task);
  };

  const approvedCommand = issue.action.command || userCommand.trim();

  const handleCopyCommand = async (event: MouseEvent) => {
    stop(event);
    if (!issue.action.command) return;

    try {
      await navigator.clipboard.writeText(issue.action.command);
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
          userProvidedCommand: !issue.action.command,
        }),
      });
      const data = await res.json().catch(() => ({} as TaskActionResponse));
      applyResponse(data);

      if (!res.ok || !data.success) {
        setError(data.error || 'Environment fix failed.');
        return;
      }

      setMessage(data.retried ? 'Fix ran and agent retry started.' : 'Fix ran successfully.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Environment fix failed.');
    } finally {
      setIsFixing(false);
    }
  };

  const handleAutoFix = async (event: MouseEvent) => {
    stop(event);
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

      const ran = data.fix?.command ? ` Ran: ${data.fix.command}` : '';
      setMessage(data.retried ? `Fix ran and agent retry started.${ran}` : `Fix ran successfully.${ran}`);
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
          {issue.userMessage}
        </div>
      )}

      {issue.action.command && !compact && (
        <code className="mt-2 block rounded border border-white/15 bg-black/20 px-2 py-1 text-[11px] break-all opacity-90">
          {issue.action.command}
        </code>
      )}

      <div className={`mt-2 flex ${compact ? 'flex-col' : 'flex-wrap'} gap-2`}>
        {issue.action.mode === 'command' && issue.action.command && (
          <button
            type="button"
            onClick={(event) => {
              stop(event);
              setIsConfirmingCommand(true);
              setIsEnteringCommand(false);
              setError(null);
              setMessage(null);
            }}
            disabled={isFixing || isRetrying}
            className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded border border-white/20 bg-white/10 px-2.5 text-[11px] font-medium hover:bg-white/20 disabled:opacity-50"
          >
            <Wrench className="w-3.5 h-3.5" />
            {isFixing ? 'Running command...' : issue.action.label}
          </button>
        )}

        {issue.action.mode === 'manual' && !issue.action.command && (
          <button
            type="button"
            onClick={handleAutoFix}
            disabled={isFixing || isRetrying}
            className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded border border-white/20 bg-white/10 px-2.5 text-[11px] font-medium hover:bg-white/20 disabled:opacity-50"
          >
            <Wrench className="w-3.5 h-3.5" />
            {isFixing ? 'Auto fixing...' : 'Auto fix & retry'}
          </button>
        )}

        {issue.action.mode === 'manual' && !issue.action.command && (
          <button
            type="button"
            onClick={(event) => {
              stop(event);
              setIsEnteringCommand(true);
              setIsConfirmingCommand(false);
              setError(null);
              setMessage(null);
            }}
            disabled={isFixing || isRetrying}
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

        {issue.action.command && (
          <button
            type="button"
            onClick={handleCopyCommand}
            className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded border border-white/15 px-2.5 text-[11px] hover:bg-white/10"
          >
            {copied ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Clipboard className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : compact ? 'Copy fix' : issue.action.mode === 'manual' ? issue.action.label : 'Copy command'}
          </button>
        )}

        <button
          type="button"
          onClick={handleRetry}
          disabled={isFixing || isRetrying}
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

      {isEnteringCommand && !issue.action.command && (
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
              disabled={isFixing || isRetrying}
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
            Source: {issue.action.commandSource || 'User input'}
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={handleRunFix}
              disabled={isFixing || isRetrying}
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
