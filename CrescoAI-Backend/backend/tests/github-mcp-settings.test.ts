import { describe, expect, it } from 'bun:test';
import { GithubMcpRuntimeService } from '../src/Network/modules/settings/github-mcp-runtime.service.js';
import type { McpSettingEntity } from '../src/Network/modules/settings/entities/mcp-setting.entity.js';
import {
  fetchToolsForClient,
  getServerCacheKey,
} from '../src/services/mcp/client.js';
import type { ConnectedMCPServer, ScopedMcpServerConfig } from '../src/services/mcp/types.js';

function createRepository() {
  const rows = new Map<string, McpSettingEntity>();
  let nextId = 1;
  const key = (userId: number, provider: string) => `${userId}:${provider}`;

  return {
    rows,
    create(input: Partial<McpSettingEntity>) {
      return { ...input } as McpSettingEntity;
    },
    async findOne(input: { where: { userId: number; provider: string } }) {
      return rows.get(key(input.where.userId, input.where.provider)) ?? null;
    },
    async save(input: McpSettingEntity) {
      const now = new Date();
      input.id ||= nextId++;
      input.createdAt ||= now;
      input.updatedAt = now;
      rows.set(key(input.userId, input.provider), input);
      return input;
    },
    async remove(input: McpSettingEntity) {
      rows.delete(key(input.userId, input.provider));
      return input;
    },
  };
}

describe('GitHub MCP settings', () => {
  it('isolates users, retains a blank PAT, and never returns the complete PAT', async () => {
    const repository = createRepository();
    const service = new GithubMcpRuntimeService(repository as never);

    const first = await service.save(1, {
      enabled: true,
      personalAccessToken: 'github_pat_first_1234',
    });
    await service.save(2, {
      enabled: true,
      personalAccessToken: 'github_pat_second_5678',
    });
    const retained = await service.save(1, { enabled: false });

    expect(first).toMatchObject({ configured: true, tokenHint: '••••1234' });
    expect(retained).toMatchObject({ configured: true, enabled: false, tokenHint: '••••1234' });
    expect(JSON.stringify(first)).not.toContain('github_pat_first_1234');
    expect((await service.getView(2)).tokenHint).toBe('••••5678');

    await service.remove(1);
    expect((await service.getView(1)).configured).toBe(false);
    expect((await service.getView(2)).configured).toBe(true);
  });

  it('rejects enabling GitHub MCP without a saved or submitted PAT', async () => {
    const service = new GithubMcpRuntimeService(createRepository() as never);
    expect(service.save(7, { enabled: true })).rejects.toThrow(
      'GitHub Personal Access Token is required',
    );
  });

  it('builds only the fixed official read-only GitHub configuration', () => {
    const service = new GithubMcpRuntimeService(createRepository() as never);
    const config = (service as unknown as {
      buildConfig(token: string): ScopedMcpServerConfig;
    }).buildConfig('github_pat_test');

    expect(config).toEqual({
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: {
        Authorization: 'Bearer github_pat_test',
        'X-MCP-Toolsets': 'context,repos',
        'X-MCP-Readonly': 'true',
      },
      scope: 'user',
    });
  });

});

function fakeConnection(config: ScopedMcpServerConfig, description: string): ConnectedMCPServer {
  return {
    name: 'github',
    type: 'connected',
    config,
    capabilities: { tools: {} },
    client: {
      async request() {
        return {
          tools: [{
            name: 'get_me',
            description,
            inputSchema: { type: 'object', properties: {} },
          }],
        };
      },
    } as never,
    cleanup: async () => {},
  };
}

describe('MCP discovery cache isolation', () => {
  it('keys same-named servers by the complete configuration signature', async () => {
    const firstConfig: ScopedMcpServerConfig = {
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer first-user' },
      scope: 'user',
    };
    const secondConfig: ScopedMcpServerConfig = {
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer second-user' },
      scope: 'user',
    };

    try {
      const [firstTools, secondTools] = await Promise.all([
        fetchToolsForClient(fakeConnection(firstConfig, 'first user tool')),
        fetchToolsForClient(fakeConnection(secondConfig, 'second user tool')),
      ]);

      expect(await firstTools[0]?.description()).toContain('first user tool');
      expect(await secondTools[0]?.description()).toContain('second user tool');
      expect(firstTools[0]).not.toBe(secondTools[0]);
    } finally {
      fetchToolsForClient.cache.delete(getServerCacheKey('github', firstConfig));
      fetchToolsForClient.cache.delete(getServerCacheKey('github', secondConfig));
    }
  });
});
