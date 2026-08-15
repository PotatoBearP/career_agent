import { describe, expect, it } from 'vitest';
import {
  normalizeAccountSetting,
  normalizeApiSetting,
  normalizeConnectionMessage,
  normalizeConnectionTestResult,
  normalizeGithubMcpSetting,
  normalizeGithubMcpTestResult,
  normalizeUserSettings,
} from './settingsClient';

describe('settingsClient normalizers', () => {
  it('normalizes settings account and API fields from snake_case payloads', () => {
    const settings = normalizeUserSettings({
      account: {
        id: 12,
        email: 'user@example.com',
        username: 'career_user',
        display_name: '职业用户',
        created_at: '2026-05-24T12:00:00.000Z',
        updated_at: '2026-05-24T12:30:00.000Z',
      },
      api_settings: [
        {
          id: 2,
          user_id: 12,
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          base_url: 'https://api.anthropic.com',
          has_api_key: true,
          api_key_hint: 'sk-ant-...abcd',
          api_key_fingerprint: 'fingerprint',
          created_at: '2026-05-24T12:01:00.000Z',
          updated_at: '2026-05-24T12:31:00.000Z',
        },
      ],
    });

    expect(settings.account).toEqual({
      id: '12',
      email: 'user@example.com',
      username: 'career_user',
      displayName: '职业用户',
      createdAt: '2026-05-24T12:00:00.000Z',
      updatedAt: '2026-05-24T12:30:00.000Z',
    });
    expect(settings.apiSettings[0]).toEqual({
      id: '2',
      userId: '12',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      baseUrl: 'https://api.anthropic.com',
      hasApiKey: true,
      apiKeyHint: 'sk-ant-...abcd',
      apiKeyFingerprint: 'fingerprint',
      createdAt: '2026-05-24T12:01:00.000Z',
      updatedAt: '2026-05-24T12:31:00.000Z',
      imageUrl: null,
      hasImageKey: false,
      imageKeyHint: null,
      imageDefaultModel: null,
      imageModels: [],
      videoUrl: null,
      hasVideoKey: false,
      videoKeyHint: null,
      videoDefaultModel: null,
      videoModels: [],
    });
  });

  it('uses safe defaults for partial account and API payloads', () => {
    expect(normalizeAccountSetting({ id: 9, username: 'fallback_user' })).toMatchObject({
      id: '9',
      email: null,
      username: 'fallback_user',
      displayName: 'fallback_user',
    });

    expect(normalizeApiSetting({})).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      baseUrl: 'https://api.anthropic.com',
      hasApiKey: false,
    });
  });

  it('extracts readable messages from Anthropic JSON error strings', () => {
    const message = normalizeConnectionMessage(JSON.stringify({
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'invalid x-api-key',
      },
    }));

    expect(message).toBe('invalid x-api-key');
  });

  it('uses Chinese fallback messages for connection test results', () => {
    expect(normalizeConnectionTestResult({
      ok: true,
      status: 200,
    }).message).toBe('连接成功');

    expect(normalizeConnectionTestResult({
      ok: false,
      status: 0,
    }).message).toBe('连接失败');
  });

  it('normalizes GitHub MCP status without exposing credential fields', () => {
    const setting = normalizeGithubMcpSetting({
      enabled: true,
      configured: true,
      token_hint: '••••1234',
      status: 'connected',
      tool_count: 2,
      tool_names: ['get_me', 'get_file_contents'],
      github_user: {
        login: 'octocat',
        name: 'The Octocat',
        html_url: 'https://github.com/octocat',
      },
    });

    expect(setting).toMatchObject({
      provider: 'github',
      enabled: true,
      configured: true,
      tokenHint: '••••1234',
      status: 'connected',
      toolCount: 2,
      githubUser: {
        login: 'octocat',
        htmlUrl: 'https://github.com/octocat',
      },
    });
    expect(Object.keys(setting)).not.toContain('personalAccessToken');

    expect(normalizeGithubMcpTestResult({ ok: true, status: 'connected' })).toMatchObject({
      ok: true,
      status: 'connected',
      message: '连接成功',
    });
  });
});
