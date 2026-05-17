import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { getJiraConfig, isJiraConfigured } from '@/lib/jira/config';
import { syncJiraToTask } from '@/lib/jira/sync';

export const dynamic = 'force-dynamic';

/**
 * Verify the Jira Cloud webhook HMAC-SHA256 signature.
 *
 * Jira Cloud sends the header `X-Hub-Signature` in the format `sha256=<hex>`.
 * See: https://developer.atlassian.com/cloud/jira/software/webhooks/
 */
function verifySignature(secret: string, signature: string, body: string): boolean {
  // Jira sends "sha256=<hex>" — strip the prefix to get the raw hex digest
  const parts = signature.split('=');
  const algorithm = parts[0]; // e.g. "sha256"
  const receivedHex = parts.slice(1).join('='); // the hex digest

  if (algorithm !== 'sha256' || !receivedHex) {
    return false;
  }

  const expectedHex = createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('hex');

  // Constant-time comparison to prevent timing attacks
  try {
    return timingSafeEqual(
      Buffer.from(receivedHex, 'hex'),
      Buffer.from(expectedHex, 'hex')
    );
  } catch {
    // If buffers are different lengths (malformed signature), fail closed
    return false;
  }
}

/**
 * POST /api/webhooks/jira
 *
 * Receives Jira Cloud webhook events and syncs them to MC tasks.
 *
 * Jira Cloud webhookEvent values:
 *   - jira:issue_created
 *   - jira:issue_updated
 *   - jira:issue_deleted
 */
export async function POST(request: NextRequest) {
  if (!isJiraConfigured()) {
    return NextResponse.json(
      { error: 'Jira integration not configured' },
      { status: 503 }
    );
  }

  const config = getJiraConfig();
  const body = await request.text();

  // HMAC signature validation (if webhook secret is configured)
  if (config.webhookSecret) {
    const signature = request.headers.get('x-hub-signature') || '';

    if (!signature || !verifySignature(config.webhookSecret, signature, body)) {
      console.warn('[Jira Webhook] Invalid signature');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const eventType = payload.webhookEvent as string | undefined;
  const issue = payload.issue as {
    id: string;
    key: string;
    fields: {
      summary: string;
      project?: { key: string };
      status?: { name: string; statusCategory?: { key: string } };
      priority?: { name: string };
    };
  } | undefined;

  if (!issue) {
    return NextResponse.json({ ok: true, skipped: 'no issue in payload' });
  }

  // Only process issues from our configured project
  if (issue.fields?.project?.key !== config.projectKey) {
    return NextResponse.json({ ok: true, skipped: 'different project' });
  }

  try {
    if (eventType === 'jira:issue_deleted') {
      // For now, log deletions but don't delete MC tasks.
      // Future: optionally mark MC task as done or archive it.
      console.log('[Jira Webhook] Issue deleted:', issue.key);
      return NextResponse.json({ ok: true, action: 'noted_deletion' });
    }

    // For created and updated events, sync to MC
    syncJiraToTask(issue.id, issue.key, {
      summary: issue.fields.summary,
      statusName: issue.fields.status?.name || 'To Do',
      statusCategoryKey: issue.fields.status?.statusCategory?.key || 'new',
      priorityName: issue.fields.priority?.name || 'Medium',
    });

    const action = eventType === 'jira:issue_created' ? 'created' : 'updated';
    return NextResponse.json({ ok: true, action });
  } catch (error) {
    console.error('[Jira Webhook] Error processing event:', error);
    return NextResponse.json(
      { error: 'Processing failed' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/webhooks/jira
 *
 * Health/status check for the Jira webhook endpoint.
 */
export async function GET() {
  return NextResponse.json({
    status: isJiraConfigured() ? 'active' : 'not_configured',
    info: 'POST Jira Cloud webhook events to this endpoint',
  });
}
