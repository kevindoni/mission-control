import { NextRequest, NextResponse } from 'next/server';
import { getJiraSyncForTask, createJiraLink, unlinkJiraIssue } from '@/lib/jira/sync';
import { isJiraConfigured } from '@/lib/jira/config';

export const dynamic = 'force-dynamic';

// GET /api/tasks/[id]/jira — get Jira sync info for a task
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const sync = getJiraSyncForTask(id);
  if (!sync) {
    return NextResponse.json({ linked: false }, { status: 200 });
  }
  return NextResponse.json({ linked: true, ...sync });
}

// POST /api/tasks/[id]/jira — create a Jira issue and link it to this task
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!isJiraConfigured()) {
    return NextResponse.json(
      { error: 'Jira integration is not configured' },
      { status: 400 }
    );
  }

  const existing = getJiraSyncForTask(id);
  if (existing) {
    return NextResponse.json(
      { error: 'Task is already linked to Jira', ...existing },
      { status: 409 }
    );
  }

  try {
    const record = await createJiraLink(id);
    if (!record) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    return NextResponse.json({ linked: true, ...record }, { status: 201 });
  } catch (error) {
    console.error('[Jira] Failed to create link:', error);
    return NextResponse.json(
      { error: 'Failed to create Jira issue' },
      { status: 500 }
    );
  }
}

// DELETE /api/tasks/[id]/jira — unlink Jira issue (does NOT delete the Jira issue)
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await unlinkJiraIssue(id);
  return NextResponse.json({ linked: false });
}
