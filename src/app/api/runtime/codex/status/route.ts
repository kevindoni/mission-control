import { NextResponse } from 'next/server';
import { getCodexCliStatus } from '@/lib/codex/status';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(await getCodexCliStatus());
  } catch (error) {
    console.error('Failed to check Codex CLI status:', error);
    return NextResponse.json(
      {
        installed: false,
        authenticated: false,
        ready: false,
        command: process.env.CODEX_CLI_PATH || 'codex',
        error: 'Failed to check Codex CLI status',
        loginCommand: 'codex login --device-auth',
        checkedAt: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
