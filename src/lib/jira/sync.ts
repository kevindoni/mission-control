import { v4 as uuidv4 } from 'uuid';
import { isJiraConfigured, getJiraConfig } from './config';
import { createJiraIssue, updateJiraIssue, transitionJiraIssue } from './client';
import { mcStatusToJira, mcPriorityToJira, jiraStatusToMc, jiraPriorityToMc } from './mappings';
import { queryOne, run } from '../db';
import { broadcast } from '../events';
import type { Task } from '../types';

export interface JiraSyncRecord {
  id: string;
  task_id: string;
  jira_issue_id: string;
  jira_issue_key: string;
  jira_issue_url: string;
  sync_enabled: number;
  last_synced_at: string | null;
  last_sync_direction: string | null;
  created_at: string;
}

/**
 * Main outbound sync: push an MC task to Jira.
 * Creates a new Jira issue if no link exists, updates if linked.
 * Never throws — failures are logged but never break task operations.
 */
export async function syncTaskToJira(taskId: string): Promise<void> {
  if (!isJiraConfigured()) return;

  try {
    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (!task) return;

    const syncRecord = queryOne<JiraSyncRecord>(
      'SELECT * FROM jira_sync WHERE task_id = ?',
      [taskId]
    );

    // Loop prevention: skip if recently synced FROM Jira
    if (syncRecord?.last_synced_at && syncRecord.last_sync_direction === 'from_jira') {
      const lastSync = new Date(syncRecord.last_synced_at).getTime();
      if (Date.now() - lastSync < 5000) return;
    }

    if (!syncRecord) {
      // No link yet — create Jira issue and link it
      await createJiraLink(taskId);
    } else if (syncRecord.sync_enabled) {
      // Linked — push updates to existing Jira issue
      const jiraStatus = mcStatusToJira(task.status);
      const jiraPriority = mcPriorityToJira(task.priority);

      await updateJiraIssue(syncRecord.jira_issue_key, {
        summary: task.title,
        description: task.description || '',
        priorityName: jiraPriority,
      });

      await transitionJiraIssue(syncRecord.jira_issue_key, jiraStatus);

      run(
        "UPDATE jira_sync SET last_synced_at = datetime('now'), last_sync_direction = ? WHERE id = ?",
        ['to_jira', syncRecord.id]
      );
    }
  } catch (error) {
    console.error('[Jira Sync] Outbound sync failed for task', taskId, error);
    // Never break task operations
  }
}

/**
 * Create a Jira issue and link it to an MC task.
 * Returns the sync record on success, null on failure.
 */
export async function createJiraLink(taskId: string): Promise<JiraSyncRecord | null> {
  if (!isJiraConfigured()) return null;

  const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task) return null;

  const config = getJiraConfig();
  const jiraPriority = mcPriorityToJira(task.priority);

  const result = await createJiraIssue({
    summary: task.title,
    description: task.description || '',
    priorityName: jiraPriority,
  });

  const jiraUrl = `${config.url}/browse/${result.key}`;
  const id = uuidv4();

  run(
    `INSERT INTO jira_sync (id, task_id, jira_issue_id, jira_issue_key, jira_issue_url, last_synced_at, last_sync_direction)
     VALUES (?, ?, ?, ?, ?, datetime('now'), 'to_jira')`,
    [id, taskId, result.id, result.key, jiraUrl]
  );

  return queryOne<JiraSyncRecord>('SELECT * FROM jira_sync WHERE id = ?', [id]) || null;
}

/**
 * Unlink a Jira issue from an MC task.
 * Does NOT delete the Jira issue — only removes the sync record.
 */
export async function unlinkJiraIssue(taskId: string): Promise<void> {
  run('DELETE FROM jira_sync WHERE task_id = ?', [taskId]);
}

/**
 * Get the Jira sync record for a given task.
 */
export function getJiraSyncForTask(taskId: string): JiraSyncRecord | undefined {
  return queryOne<JiraSyncRecord>('SELECT * FROM jira_sync WHERE task_id = ?', [taskId]);
}

/**
 * Inbound sync: Jira webhook → MC task.
 * Creates a new MC task if no link exists, updates if linked.
 * Never throws — failures are logged but never break webhook processing.
 */
export function syncJiraToTask(jiraIssueId: string, jiraIssueKey: string, fields: {
  summary: string;
  statusName: string;
  statusCategoryKey: string;
  priorityName: string;
}): void {
  const syncRecord = queryOne<JiraSyncRecord>(
    'SELECT * FROM jira_sync WHERE jira_issue_id = ?',
    [jiraIssueId]
  );

  if (!syncRecord) {
    // No link yet — create a new MC task from the Jira issue
    const mcPriority = jiraPriorityToMc(fields.priorityName);
    const mcStatus = jiraStatusToMc(fields.statusName, fields.statusCategoryKey);
    const id = uuidv4();

    run(
      `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'default', 'default', datetime('now'), datetime('now'))`,
      [id, fields.summary, mcStatus, mcPriority]
    );

    const config = getJiraConfig();
    const jiraUrl = `${config.url}/browse/${jiraIssueKey}`;
    const syncId = uuidv4();

    run(
      `INSERT INTO jira_sync (id, task_id, jira_issue_id, jira_issue_key, jira_issue_url, last_synced_at, last_sync_direction)
       VALUES (?, ?, ?, ?, ?, datetime('now'), 'from_jira')`,
      [syncId, id, jiraIssueId, jiraIssueKey, jiraUrl]
    );

    // Broadcast SSE event so the UI updates in real time
    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
    if (task) {
      broadcast({ type: 'task_created', payload: task });
    }
  } else {
    // Linked — update existing MC task
    const mcPriority = jiraPriorityToMc(fields.priorityName);
    const mcStatus = jiraStatusToMc(fields.statusName, fields.statusCategoryKey);

    run(
      `UPDATE tasks SET title = ?, status = ?, priority = ?, updated_at = datetime('now') WHERE id = ?`,
      [fields.summary, mcStatus, mcPriority, syncRecord.task_id]
    );

    run(
      `UPDATE jira_sync SET last_synced_at = datetime('now'), last_sync_direction = 'from_jira' WHERE id = ?`,
      [syncRecord.id]
    );

    // Broadcast SSE event so the UI updates in real time
    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [syncRecord.task_id]);
    if (task) {
      broadcast({ type: 'task_updated', payload: task });
    }
  }
}
