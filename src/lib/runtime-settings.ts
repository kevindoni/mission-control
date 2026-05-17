import { queryOne, run } from '@/lib/db';

export type AgentRuntimeProvider = 'openclaw' | 'codex';

export interface AgentRuntimeSettings {
  provider: AgentRuntimeProvider;
  codexCloudEnvironmentId: string;
  codexDefaultBranch: string;
  envOverrides: {
    provider: boolean;
    codexCloudEnvironmentId: boolean;
    codexDefaultBranch: boolean;
  };
}

type RuntimeSettingsUpdate = Partial<Pick<AgentRuntimeSettings, 'provider' | 'codexCloudEnvironmentId' | 'codexDefaultBranch'>>;

interface SettingRow {
  value: string;
}

const SETTING_KEYS = {
  provider: 'agent_runtime_provider',
  codexCloudEnvironmentId: 'codex_cloud_environment_id',
  codexDefaultBranch: 'codex_default_branch',
} as const;

function getSetting(key: string): string | undefined {
  return queryOne<SettingRow>('SELECT value FROM app_settings WHERE key = ?', [key])?.value;
}

function setSetting(key: string, value: string): void {
  run(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value]
  );
}

function normalizeProvider(value: string | undefined): AgentRuntimeProvider {
  return value === 'codex' ? 'codex' : 'openclaw';
}

function normalizeOptionalText(value: string | undefined): string {
  return (value || '').trim();
}

function validateSettingsUpdate(updates: RuntimeSettingsUpdate): void {
  if (updates.provider !== undefined && updates.provider !== 'openclaw' && updates.provider !== 'codex') {
    throw new Error('Invalid runtime provider');
  }

  if (updates.codexCloudEnvironmentId !== undefined && updates.codexCloudEnvironmentId.length > 200) {
    throw new Error('Codex Cloud environment ID is too long');
  }

  if (updates.codexDefaultBranch !== undefined && updates.codexDefaultBranch.length > 200) {
    throw new Error('Codex default branch is too long');
  }
}

export function getAgentRuntimeSettings(): AgentRuntimeSettings {
  const providerFromEnv = process.env.AGENT_RUNTIME_PROVIDER;
  const codexCloudEnvironmentFromEnv = process.env.CODEX_CLOUD_ENV_ID;
  const codexDefaultBranchFromEnv = process.env.CODEX_DEFAULT_BRANCH;

  return {
    provider: normalizeProvider(providerFromEnv || getSetting(SETTING_KEYS.provider)),
    codexCloudEnvironmentId: normalizeOptionalText(
      codexCloudEnvironmentFromEnv || getSetting(SETTING_KEYS.codexCloudEnvironmentId)
    ),
    codexDefaultBranch: normalizeOptionalText(
      codexDefaultBranchFromEnv || getSetting(SETTING_KEYS.codexDefaultBranch)
    ),
    envOverrides: {
      provider: Boolean(providerFromEnv),
      codexCloudEnvironmentId: Boolean(codexCloudEnvironmentFromEnv),
      codexDefaultBranch: Boolean(codexDefaultBranchFromEnv),
    },
  };
}

export function updateAgentRuntimeSettings(updates: RuntimeSettingsUpdate): AgentRuntimeSettings {
  validateSettingsUpdate(updates);

  if (updates.provider !== undefined) {
    setSetting(SETTING_KEYS.provider, updates.provider);
  }

  if (updates.codexCloudEnvironmentId !== undefined) {
    setSetting(SETTING_KEYS.codexCloudEnvironmentId, normalizeOptionalText(updates.codexCloudEnvironmentId));
  }

  if (updates.codexDefaultBranch !== undefined) {
    setSetting(SETTING_KEYS.codexDefaultBranch, normalizeOptionalText(updates.codexDefaultBranch));
  }

  return getAgentRuntimeSettings();
}
