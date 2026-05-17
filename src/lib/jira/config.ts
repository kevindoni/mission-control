export interface JiraConfig {
  enabled: boolean;
  url: string;
  email: string;
  apiToken: string;
  projectKey: string;
  webhookSecret: string;
}

export function getJiraConfig(): JiraConfig {
  return {
    enabled: process.env.JIRA_SYNC === 'true',
    url: (process.env.JIRA_URL || '').replace(/\/$/, ''),
    email: process.env.JIRA_EMAIL || '',
    apiToken: process.env.JIRA_API_TOKEN || '',
    projectKey: process.env.JIRA_PROJECT_KEY || '',
    webhookSecret: process.env.JIRA_WEBHOOK_SECRET || '',
  };
}

export function isJiraConfigured(): boolean {
  const config = getJiraConfig();
  return config.enabled && !!config.url && !!config.email && !!config.apiToken && !!config.projectKey;
}
