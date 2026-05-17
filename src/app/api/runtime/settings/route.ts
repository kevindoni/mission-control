import { NextRequest, NextResponse } from 'next/server';
import { getAgentRuntimeSettings, updateAgentRuntimeSettings } from '@/lib/runtime-settings';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(getAgentRuntimeSettings());
  } catch (error) {
    console.error('Failed to read runtime settings:', error);
    return NextResponse.json({ error: 'Failed to read runtime settings' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const settings = updateAgentRuntimeSettings({
      provider: body.provider,
      codexCloudEnvironmentId: body.codexCloudEnvironmentId,
      codexDefaultBranch: body.codexDefaultBranch,
    });

    return NextResponse.json(settings);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update runtime settings';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
