import { getJiraConfig } from './config';

// ── Internal helpers ──────────────────────────────────────────────────

async function jiraFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const config = getJiraConfig();
  const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');

  const url = `${config.url}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '(no body)');
    throw new Error(`Jira API ${options.method || 'GET'} ${path} failed (${res.status}): ${body}`);
  }

  return res;
}

/**
 * Convert plain text to a simple Atlassian Document Format (ADF) document.
 * Jira REST API v3 requires description in ADF rather than plain text.
 */
function textToAdf(text: string): object {
  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text,
          },
        ],
      },
    ],
  };
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Create a new Jira issue.
 */
export async function createJiraIssue(params: {
  summary: string;
  description?: string;
  priorityName?: string;
  issueTypeName?: string;
}): Promise<{ id: string; key: string; self: string }> {
  const config = getJiraConfig();

  const fields: Record<string, unknown> = {
    project: { key: config.projectKey },
    summary: params.summary,
    issuetype: { name: params.issueTypeName || 'Task' },
  };

  if (params.description) {
    fields.description = textToAdf(params.description);
  }

  if (params.priorityName) {
    fields.priority = { name: params.priorityName };
  }

  const res = await jiraFetch('/rest/api/3/issue', {
    method: 'POST',
    body: JSON.stringify({ fields }),
  });

  return res.json() as Promise<{ id: string; key: string; self: string }>;
}

/**
 * Update an existing Jira issue.
 */
export async function updateJiraIssue(
  issueIdOrKey: string,
  params: {
    summary?: string;
    description?: string;
    priorityName?: string;
  },
): Promise<void> {
  const fields: Record<string, unknown> = {};

  if (params.summary !== undefined) {
    fields.summary = params.summary;
  }

  if (params.description !== undefined) {
    fields.description = textToAdf(params.description);
  }

  if (params.priorityName !== undefined) {
    fields.priority = { name: params.priorityName };
  }

  await jiraFetch(`/rest/api/3/issue/${issueIdOrKey}`, {
    method: 'PUT',
    body: JSON.stringify({ fields }),
  });
}

/**
 * Transition a Jira issue to a target status.
 *
 * Jira does not allow setting status directly -- you must find the
 * available transition that leads to the desired status and invoke it.
 *
 * Returns true if transitioned, false if no matching transition was found.
 */
export async function transitionJiraIssue(
  issueIdOrKey: string,
  targetStatusName: string,
): Promise<boolean> {
  // Step 1: Get available transitions
  const res = await jiraFetch(`/rest/api/3/issue/${issueIdOrKey}/transitions`);
  const data = (await res.json()) as {
    transitions: { id: string; name: string; to: { name: string } }[];
  };

  // Step 2: Find a transition whose target status matches (case-insensitive)
  const target = targetStatusName.toLowerCase();
  const match = data.transitions.find(
    (t) => t.to.name.toLowerCase() === target || t.name.toLowerCase() === target,
  );

  if (!match) {
    return false;
  }

  // Step 3: Perform the transition
  await jiraFetch(`/rest/api/3/issue/${issueIdOrKey}/transitions`, {
    method: 'POST',
    body: JSON.stringify({ transition: { id: match.id } }),
  });

  return true;
}

/**
 * Get a Jira issue by ID or key.
 */
export async function getJiraIssue(issueIdOrKey: string): Promise<{
  id: string;
  key: string;
  fields: {
    summary: string;
    description: unknown;
    status: { name: string; statusCategory: { key: string } };
    priority: { name: string };
  };
}> {
  const res = await jiraFetch(`/rest/api/3/issue/${issueIdOrKey}`);
  return res.json() as Promise<{
    id: string;
    key: string;
    fields: {
      summary: string;
      description: unknown;
      status: { name: string; statusCategory: { key: string } };
      priority: { name: string };
    };
  }>;
}

/**
 * Delete a Jira issue.
 */
export async function deleteJiraIssue(issueIdOrKey: string): Promise<void> {
  await jiraFetch(`/rest/api/3/issue/${issueIdOrKey}`, {
    method: 'DELETE',
  });
}
