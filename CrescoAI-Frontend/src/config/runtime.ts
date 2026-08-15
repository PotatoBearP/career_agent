export type CareerAgentClientMode = 'mock' | 'upstream';
export type ArtifactTransport = 'mock' | 'polling' | 'sse' | 'websocket';

export interface RuntimeEnvLike {
  MODE?: string;
  VITE_CAREER_AGENT_CLIENT_MODE?: string;
  VITE_CAREER_AGENT_API_BASE_URL?: string;
  VITE_CAREER_AGENT_USER_ID?: string;
  VITE_CAREER_AGENT_WITH_CREDENTIALS?: string;
  VITE_CAREER_AGENT_ARTIFACT_TRANSPORT?: string;
  VITE_CAREER_AGENT_ENABLE_VOICE_INPUT?: string;
  VITE_CAREER_AGENT_TRUSTED_CANVAS_ORIGINS?: string;
  VITE_CAREER_AGENT_NODE_CANVAS_FIXTURE_URL?: string;
  VITE_CAREER_AGENT_HTML_APP_EXAMPLE_URL?: string;
  VITE_CAREER_AGENT_NODE_APP_EXAMPLE_URL?: string;
  VITE_CAREER_AGENT_SKIP_AUTH?: string;
}

export interface RuntimeConfig {
  environmentName: string;
  clientMode: CareerAgentClientMode;
  apiBaseUrl: string | null;
  userId: string;
  upstreamWithCredentials: boolean;
  artifactTransport: ArtifactTransport;
  voiceInputEnabled: boolean;
  trustedCanvasOrigins: string[];
  nodeCanvasFixtureUrl: string | null;
  htmlAppExampleUrl: string | null;
  nodeAppExampleUrl: string | null;
  upstreamConfigured: boolean;
  skipAuth: boolean;
}

function normalizeClientMode(value: string | undefined): CareerAgentClientMode {
  return value === 'upstream' ? 'upstream' : 'mock';
}

function normalizeBaseUrl(value: string | undefined): string | null {
  const nextValue = value?.trim();

  if (!nextValue) {
    return null;
  }

  if (nextValue === '/') {
    return '/';
  }

  return nextValue.replace(/\/+$/, '');
}

function normalizeUserId(value: string | undefined, skipAuth: boolean): string {
  const nextValue = value?.trim();
  return nextValue || (skipAuth ? '1' : '');
}

function normalizeBoolean(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalizedValue = value.trim().toLowerCase();
  return normalizedValue === 'true' || normalizedValue === '1' || normalizedValue === 'yes' || normalizedValue === 'on';
}

function normalizeTrustedCanvasOrigins(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  const origins = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      try {
        const nextUrl = new URL(entry);
        if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
          return null;
        }

        return nextUrl.origin;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is string => Boolean(entry));

  return [...new Set(origins)];
}

function normalizeArtifactTransport(
  clientMode: CareerAgentClientMode,
  value: string | undefined,
): ArtifactTransport {
  if (clientMode === 'mock') {
    return 'mock';
  }

  if (value === 'sse' || value === 'websocket' || value === 'polling') {
    return value;
  }

  return 'polling';
}

function normalizeOptionalUrl(value: string | undefined): string | null {
  const nextValue = value?.trim();

  if (!nextValue) {
    return null;
  }

  return nextValue;
}

export function resolveRuntimeConfig(env: RuntimeEnvLike): RuntimeConfig {
  const clientMode = normalizeClientMode(env.VITE_CAREER_AGENT_CLIENT_MODE);
  const apiBaseUrl = normalizeBaseUrl(env.VITE_CAREER_AGENT_API_BASE_URL);
  const skipAuth = normalizeBoolean(env.VITE_CAREER_AGENT_SKIP_AUTH);

  return {
    environmentName: env.MODE?.trim() || 'development',
    clientMode,
    apiBaseUrl,
    userId: normalizeUserId(env.VITE_CAREER_AGENT_USER_ID, skipAuth),
    upstreamWithCredentials: normalizeBoolean(env.VITE_CAREER_AGENT_WITH_CREDENTIALS),
    artifactTransport: normalizeArtifactTransport(clientMode, env.VITE_CAREER_AGENT_ARTIFACT_TRANSPORT),
    voiceInputEnabled: normalizeBoolean(env.VITE_CAREER_AGENT_ENABLE_VOICE_INPUT),
    trustedCanvasOrigins: normalizeTrustedCanvasOrigins(env.VITE_CAREER_AGENT_TRUSTED_CANVAS_ORIGINS),
    nodeCanvasFixtureUrl: normalizeOptionalUrl(env.VITE_CAREER_AGENT_NODE_CANVAS_FIXTURE_URL),
    htmlAppExampleUrl: normalizeOptionalUrl(env.VITE_CAREER_AGENT_HTML_APP_EXAMPLE_URL),
    nodeAppExampleUrl: normalizeOptionalUrl(env.VITE_CAREER_AGENT_NODE_APP_EXAMPLE_URL),
    upstreamConfigured: clientMode === 'upstream' && Boolean(apiBaseUrl),
    skipAuth,
  };
}

export const runtimeConfig = resolveRuntimeConfig(import.meta.env);
