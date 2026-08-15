import { describe, expect, it } from 'vitest';
import { resolveRuntimeConfig } from './runtime';

describe('resolveRuntimeConfig', () => {
  it('defaults to mock runtime when env values are absent', () => {
    const config = resolveRuntimeConfig({});

    expect(config).toEqual({
      environmentName: 'development',
      clientMode: 'mock',
      apiBaseUrl: null,
      userId: '',
      upstreamWithCredentials: false,
      artifactTransport: 'mock',
      voiceInputEnabled: false,
      trustedCanvasOrigins: [],
      nodeCanvasFixtureUrl: null,
      htmlAppExampleUrl: null,
      nodeAppExampleUrl: null,
      upstreamConfigured: false,
      skipAuth: false,
    });
  });

  it('normalizes upstream values and trims trailing slashes', () => {
    const config = resolveRuntimeConfig({
      MODE: 'production',
      VITE_CAREER_AGENT_CLIENT_MODE: 'upstream',
      VITE_CAREER_AGENT_API_BASE_URL: 'https://agent.example.com///',
      VITE_CAREER_AGENT_USER_ID: ' 42 ',
      VITE_CAREER_AGENT_WITH_CREDENTIALS: 'yes',
      VITE_CAREER_AGENT_ARTIFACT_TRANSPORT: 'sse',
      VITE_CAREER_AGENT_ENABLE_VOICE_INPUT: 'true',
      VITE_CAREER_AGENT_TRUSTED_CANVAS_ORIGINS:
        'https://canvas.example.com, invalid, https://canvas.example.com/path, http://localhost:3000',
      VITE_CAREER_AGENT_NODE_CANVAS_FIXTURE_URL: 'http://127.0.0.1:4318',
      VITE_CAREER_AGENT_HTML_APP_EXAMPLE_URL: 'http://127.0.0.1:4320',
      VITE_CAREER_AGENT_NODE_APP_EXAMPLE_URL: 'http://127.0.0.1:3000',
    });

    expect(config).toEqual({
      environmentName: 'production',
      clientMode: 'upstream',
      apiBaseUrl: 'https://agent.example.com',
      userId: '42',
      upstreamWithCredentials: true,
      artifactTransport: 'sse',
      voiceInputEnabled: true,
      trustedCanvasOrigins: ['https://canvas.example.com', 'http://localhost:3000'],
      nodeCanvasFixtureUrl: 'http://127.0.0.1:4318',
      htmlAppExampleUrl: 'http://127.0.0.1:4320',
      nodeAppExampleUrl: 'http://127.0.0.1:3000',
      upstreamConfigured: true,
      skipAuth: false,
    });
  });

  it('enables skipAuth when the flag is set', () => {
    const config = resolveRuntimeConfig({ VITE_CAREER_AGENT_SKIP_AUTH: 'true' });
    expect(config.skipAuth).toBe(true);
    expect(config.userId).toBe('1');
  });

  it('preserves the same-origin API base used by a reverse proxy', () => {
    const config = resolveRuntimeConfig({
      VITE_CAREER_AGENT_CLIENT_MODE: 'upstream',
      VITE_CAREER_AGENT_API_BASE_URL: '/',
    });

    expect(config.apiBaseUrl).toBe('/');
    expect(config.upstreamConfigured).toBe(true);
  });

  it('falls back to polling for invalid upstream transport values', () => {
    const config = resolveRuntimeConfig({
      VITE_CAREER_AGENT_CLIENT_MODE: 'upstream',
      VITE_CAREER_AGENT_API_BASE_URL: 'https://agent.example.com',
      VITE_CAREER_AGENT_ARTIFACT_TRANSPORT: 'invalid',
    });

    expect(config.artifactTransport).toBe('polling');
  });

  it('does not invent a user id outside explicit skip-auth mode', () => {
    const config = resolveRuntimeConfig({
      VITE_CAREER_AGENT_USER_ID: ' ',
    });

    expect(config.userId).toBe('');
  });
});
