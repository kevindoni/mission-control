import { NextResponse } from 'next/server';
import { getJiraConfig, isJiraConfigured } from '@/lib/jira/config';

export const dynamic = 'force-dynamic';

// GET /api/jira/status — returns Jira integration status
export async function GET() {
  const config = getJiraConfig();
  return NextResponse.json({
    enabled: config.enabled,
    configured: isJiraConfigured(),
    ...(isJiraConfigured() && {
      url: config.url,
      projectKey: config.projectKey,
    }),
  });
}
