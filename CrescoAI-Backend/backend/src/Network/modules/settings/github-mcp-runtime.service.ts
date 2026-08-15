import {
  BadRequestException,
  Injectable,
  OnApplicationShutdown,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import type { Tool } from '../../../Tool.js';
import {
  clearServerCache,
  prefetchAllMcpResources,
} from '../../../services/mcp/client.js';
import type {
  ConnectedMCPServer,
  MCPServerConnection,
  ScopedMcpServerConfig,
} from '../../../services/mcp/types.js';
import { Repository } from 'typeorm';
import { McpSettingEntity } from './entities/mcp-setting.entity.js';

const GITHUB_MCP_PROVIDER = 'github';
const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/';
const GITHUB_MCP_RETRY_COOLDOWN_MS = 30_000;

export type GithubMcpConnectionStatus =
  | 'not_configured'
  | 'disabled'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'failed';

export interface GithubMcpUser {
  login: string | null;
  name: string | null;
  htmlUrl: string | null;
}

export interface GithubMcpRuntimeSnapshot {
  status: GithubMcpConnectionStatus;
  version: number;
  clients: MCPServerConnection[];
  tools: Tool[];
  githubUser: GithubMcpUser | null;
  lastError: string | null;
  connectedAt: string | null;
  lastAttemptAt: number | null;
}

interface GithubMcpRuntimeEntry extends GithubMcpRuntimeSnapshot {
  config?: ScopedMcpServerConfig;
}

@Injectable()
export class GithubMcpRuntimeService implements OnApplicationShutdown {
  private readonly runtimes = new Map<number, GithubMcpRuntimeEntry>();
  private readonly initializations = new Map<number, Promise<GithubMcpRuntimeSnapshot>>();
  private readonly versions = new Map<number, number>();

  constructor(
    @InjectRepository(McpSettingEntity)
    private readonly settingsRepo: Repository<McpSettingEntity>,
  ) {}

  async getView(userId: number) {
    const setting = await this.findSetting(userId);
    const runtime = this.runtimes.get(userId);
    return this.toView(setting, runtime);
  }

  async save(userId: number, input: { enabled: boolean; personalAccessToken?: string }) {
    let setting = await this.findSetting(userId);
    if (!setting) {
      setting = this.settingsRepo.create({
        userId,
        provider: GITHUB_MCP_PROVIDER,
        enabled: false,
      });
    }

    const token = input.personalAccessToken?.trim();
    if (token) setting.personalAccessToken = token;
    if (input.enabled && !setting.personalAccessToken) {
      throw new BadRequestException({
        code: 'GITHUB_MCP_PAT_REQUIRED',
        message: 'GitHub Personal Access Token is required when MCP is enabled',
      });
    }
    setting.enabled = input.enabled;
    const saved = await this.settingsRepo.save(setting);
    await this.invalidate(userId);
    return this.toView(saved, undefined);
  }

  async remove(userId: number) {
    const setting = await this.findSetting(userId);
    await this.invalidate(userId);
    if (setting) await this.settingsRepo.remove(setting);
    return this.toView(null, undefined);
  }

  async test(userId: number, suppliedToken?: string) {
    const token = suppliedToken?.trim();
    if (token) {
      return this.testEphemeral(userId, token);
    }

    const setting = await this.findSetting(userId);
    if (!setting?.personalAccessToken) {
      throw new BadRequestException({
        code: 'GITHUB_MCP_PAT_REQUIRED',
        message: 'Please provide or save a GitHub Personal Access Token',
      });
    }

    if (!setting.enabled) {
      return this.testEphemeral(userId, setting.personalAccessToken);
    }

    const runtime = await this.connect(userId, setting, { ignoreEnabled: true, ignoreCooldown: true });
    return this.toTestResult(runtime);
  }

  async ensureConnected(userId: number): Promise<GithubMcpRuntimeSnapshot> {
    const setting = await this.findSetting(userId);
    if (!setting?.personalAccessToken) {
      return this.storeNonConnected(userId, 'not_configured');
    }
    if (!setting.enabled) {
      return this.storeNonConnected(userId, 'disabled');
    }
    return this.connect(userId, setting);
  }

  getSnapshot(userId: number): GithubMcpRuntimeSnapshot {
    return this.runtimes.get(userId) ?? this.emptySnapshot(userId, 'disconnected');
  }

  private async connect(
    userId: number,
    setting: McpSettingEntity,
    options: { ignoreEnabled?: boolean; ignoreCooldown?: boolean } = {},
  ): Promise<GithubMcpRuntimeSnapshot> {
    if (!options.ignoreEnabled && !setting.enabled) {
      return this.storeNonConnected(userId, 'disabled');
    }

    const current = this.runtimes.get(userId);
    if (current?.status === 'connected') return current;
    if (!options.ignoreCooldown
      && current?.status === 'failed'
      && current.lastAttemptAt
      && Date.now() - current.lastAttemptAt < GITHUB_MCP_RETRY_COOLDOWN_MS) {
      return current;
    }

    const pending = this.initializations.get(userId);
    if (pending) return pending;

    const initialization = this.initializeRuntime(userId, setting.personalAccessToken!);
    this.initializations.set(userId, initialization);
    try {
      return await initialization;
    } finally {
      if (this.initializations.get(userId) === initialization) {
        this.initializations.delete(userId);
      }
    }
  }

  private async initializeRuntime(userId: number, token: string) {
    const version = this.bumpVersion(userId);
    const connecting: GithubMcpRuntimeEntry = {
      ...this.emptySnapshot(userId, 'connecting', version),
      lastAttemptAt: Date.now(),
    };
    this.runtimes.set(userId, connecting);
    const config = this.buildConfig(token);

    try {
      const result = await prefetchAllMcpResources({ github: config });
      const connected = result.clients.find(
        (client): client is ConnectedMCPServer => client.type === 'connected',
      );
      if (!connected) {
        const failure = result.clients.find((client) => client.type === 'failed');
        throw new Error(failure?.type === 'failed' ? failure.error || 'GitHub MCP connection failed' : 'GitHub MCP connection failed');
      }

      if (!this.isCurrentVersion(userId, version)) {
        await clearServerCache('github', config);
        return this.currentOrDisconnected(userId);
      }

      const githubUser = await this.callGetMe(connected);
      if (!this.isCurrentVersion(userId, version)) {
        await clearServerCache('github', config);
        return this.currentOrDisconnected(userId);
      }
      const runtime: GithubMcpRuntimeEntry = {
        status: 'connected',
        version,
        clients: result.clients,
        tools: result.tools,
        githubUser,
        lastError: null,
        connectedAt: new Date().toISOString(),
        lastAttemptAt: Date.now(),
        config,
      };
      this.runtimes.set(userId, runtime);
      return runtime;
    } catch (error) {
      if (!this.isCurrentVersion(userId, version)) {
        await clearServerCache('github', config);
        return this.currentOrDisconnected(userId);
      }
      const failed: GithubMcpRuntimeEntry = {
        ...this.emptySnapshot(userId, 'failed', version),
        lastError: this.safeError(error, token),
        lastAttemptAt: Date.now(),
        config,
      };
      this.runtimes.set(userId, failed);
      return failed;
    }
  }

  private async testEphemeral(userId: number, token: string) {
    const serverName = `github-test-${userId}-${randomUUID()}`;
    const config = this.buildConfig(token);
    try {
      const result = await prefetchAllMcpResources({ [serverName]: config });
      const connected = result.clients.find(
        (client): client is ConnectedMCPServer => client.type === 'connected',
      );
      if (!connected) {
        const failure = result.clients.find((client) => client.type === 'failed');
        throw new Error(failure?.type === 'failed' ? failure.error || 'GitHub MCP connection failed' : 'GitHub MCP connection failed');
      }
      const githubUser = await this.callGetMe(connected);
      return {
        ok: true,
        status: 'connected' as const,
        toolCount: result.tools.length,
        toolNames: this.toolNames(result.tools),
        githubUser,
        message: 'GitHub MCP connection and get_me call succeeded',
      };
    } catch (error) {
      return {
        ok: false,
        status: 'failed' as const,
        toolCount: 0,
        toolNames: [] as string[],
        githubUser: null,
        message: this.safeError(error, token),
      };
    } finally {
      await clearServerCache(serverName, config);
    }
  }

  private async callGetMe(client: ConnectedMCPServer): Promise<GithubMcpUser | null> {
    const result = await client.client.callTool(
      { name: 'get_me', arguments: {} },
      undefined,
      { timeout: 15_000 },
    );
    if (result.isError) throw new Error('GitHub MCP get_me returned an error');
    return this.extractGithubUser(result);
  }

  private extractGithubUser(value: unknown): GithubMcpUser | null {
    const candidates: unknown[] = [value];
    const record = this.asRecord(value);
    if (record?.structuredContent) candidates.push(record.structuredContent);
    if (Array.isArray(record?.content)) {
      for (const item of record.content) {
        candidates.push(item);
        const itemRecord = this.asRecord(item);
        if (typeof itemRecord?.text === 'string') {
          try { candidates.push(JSON.parse(itemRecord.text)); } catch { /* Text may be prose. */ }
        }
      }
    }

    while (candidates.length) {
      const candidate = this.asRecord(candidates.shift());
      if (!candidate) continue;
      const login = this.firstString(candidate.login, candidate.username, candidate.user_login);
      if (login) {
        return {
          login,
          name: this.firstString(candidate.name),
          htmlUrl: this.firstString(candidate.html_url, candidate.htmlUrl, candidate.url),
        };
      }
      candidates.push(...Object.values(candidate));
    }
    return null;
  }

  private buildConfig(token: string): ScopedMcpServerConfig {
    return {
      type: 'http',
      url: GITHUB_MCP_URL,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-MCP-Toolsets': 'context,repos',
        'X-MCP-Readonly': 'true',
      },
      scope: 'user',
    };
  }

  private async invalidate(userId: number) {
    const runtime = this.runtimes.get(userId);
    this.bumpVersion(userId);
    this.initializations.delete(userId);
    this.runtimes.delete(userId);
    if (runtime?.config) await clearServerCache('github', runtime.config);
  }

  private storeNonConnected(userId: number, status: 'not_configured' | 'disabled') {
    const current = this.runtimes.get(userId);
    if (current?.status === status) return current;
    const snapshot = this.emptySnapshot(userId, status, this.bumpVersion(userId));
    this.runtimes.set(userId, snapshot);
    return snapshot;
  }

  private emptySnapshot(
    userId: number,
    status: GithubMcpConnectionStatus,
    version = this.versions.get(userId) ?? 0,
  ): GithubMcpRuntimeSnapshot {
    return {
      status,
      version,
      clients: [],
      tools: [],
      githubUser: null,
      lastError: null,
      connectedAt: null,
      lastAttemptAt: null,
    };
  }

  private toView(setting: McpSettingEntity | null, runtime?: GithubMcpRuntimeEntry) {
    const token = setting?.personalAccessToken?.trim();
    return {
      provider: GITHUB_MCP_PROVIDER,
      endpoint: GITHUB_MCP_URL,
      enabled: Boolean(setting?.enabled),
      configured: Boolean(token),
      tokenHint: token ? `••••${token.slice(-4)}` : null,
      status: runtime?.status ?? (setting?.enabled ? 'disconnected' : setting ? 'disabled' : 'not_configured'),
      toolCount: runtime?.tools.length ?? 0,
      toolNames: this.toolNames(runtime?.tools ?? []),
      githubUser: runtime?.githubUser ?? null,
      lastError: runtime?.lastError ?? null,
      connectedAt: runtime?.connectedAt ?? null,
    };
  }

  private toTestResult(runtime: GithubMcpRuntimeSnapshot) {
    return {
      ok: runtime.status === 'connected',
      status: runtime.status,
      toolCount: runtime.tools.length,
      toolNames: this.toolNames(runtime.tools),
      githubUser: runtime.githubUser,
      message: runtime.status === 'connected'
        ? 'GitHub MCP connection and get_me call succeeded'
        : runtime.lastError || 'GitHub MCP connection failed',
    };
  }

  private toolNames(tools: Tool[]) {
    return tools.map((tool) =>
      tool.mcpInfo?.toolName
        ? `mcp__github__${tool.mcpInfo.toolName}`
        : tool.name,
    ).sort();
  }

  private findSetting(userId: number) {
    return this.settingsRepo.findOne({ where: { userId, provider: GITHUB_MCP_PROVIDER } });
  }

  private bumpVersion(userId: number) {
    const version = (this.versions.get(userId) ?? 0) + 1;
    this.versions.set(userId, version);
    return version;
  }

  private isCurrentVersion(userId: number, version: number) {
    return this.versions.get(userId) === version;
  }

  private currentOrDisconnected(userId: number) {
    return this.runtimes.get(userId)
      ?? this.emptySnapshot(userId, 'disconnected', this.versions.get(userId) ?? 0);
  }

  private safeError(error: unknown, token: string) {
    const message = error instanceof Error ? error.message : String(error);
    return message.split(token).join('[REDACTED]').slice(0, 500);
  }

  private asRecord(value: unknown): Record<string, any> | null {
    return typeof value === 'object' && value !== null ? value as Record<string, any> : null;
  }

  private firstString(...values: unknown[]) {
    return values.find((value): value is string => typeof value === 'string' && Boolean(value.trim()))?.trim() ?? null;
  }

  async onApplicationShutdown() {
    const entries = [...this.runtimes.entries()];
    this.runtimes.clear();
    await Promise.allSettled(entries.map(async ([, runtime]) => {
      if (runtime.config) await clearServerCache('github', runtime.config);
    }));
  }
}
