<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { storeToRefs } from 'pinia';
import MobileRailTrigger from '../modules/navigation/MobileRailTrigger.vue';
import { runtimeConfig } from '../config/runtime';
import { createSettingsClient } from '../services/settingsClient';
import { useAuthStore } from '../stores/auth';
import type {
  AccountSetting,
  ApiSetting,
  ConnectionTestResult,
  GithubMcpSetting,
  GithubMcpTestResult,
  LoadState,
  UserSettings,
} from '../types/entities';

const settingsClient = createSettingsClient();
const authStore = useAuthStore();
const { session } = storeToRefs(authStore);

const settings = ref<UserSettings | null>(null);
const loadStatus = ref<LoadState>('idle');
const accountSaveStatus = ref<LoadState>('idle');
const apiSaveStatus = ref<LoadState>('idle');
const apiTestStatus = ref<LoadState>('idle');
const errorMessage = ref<string | null>(null);
const successMessage = ref<string | null>(null);
const testResult = ref<ConnectionTestResult | null>(null);
const githubMcpSetting = ref<GithubMcpSetting | null>(null);
const githubMcpTestResult = ref<GithubMcpTestResult | null>(null);
const githubMcpSaveStatus = ref<LoadState>('idle');
const githubMcpTestStatus = ref<LoadState>('idle');
const githubMcpDeleteStatus = ref<LoadState>('idle');

const accountForm = reactive({
  username: '',
  displayName: '',
});

const apiForm = reactive({
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  baseUrl: 'https://api.anthropic.com',
  apiKey: '',
});

const multimodalSaveStatus = ref<LoadState>('idle');
const isSavingMultimodal = computed(() => multimodalSaveStatus.value === 'loading');

const imageForm = reactive({
  imageUrl: '',
  imageKey: '',
  imageDefaultModel: '',
  imageModels: '',
});

const videoForm = reactive({
  videoUrl: '',
  videoKey: '',
  videoDefaultModel: '',
  videoModels: '',
});

const githubMcpForm = reactive({
  enabled: false,
  personalAccessToken: '',
});

const isLoading = computed(() => loadStatus.value === 'loading');
const isSavingAccount = computed(() => accountSaveStatus.value === 'loading');
const isSavingApi = computed(() => apiSaveStatus.value === 'loading');
const isTestingApi = computed(() => apiTestStatus.value === 'loading');
const isSavingGithubMcp = computed(() => githubMcpSaveStatus.value === 'loading');
const isTestingGithubMcp = computed(() => githubMcpTestStatus.value === 'loading');
const isDeletingGithubMcp = computed(() => githubMcpDeleteStatus.value === 'loading');
const primaryApiSetting = computed(() => settings.value?.apiSettings[0] ?? null);

const accountMeta = computed(() => {
  const account = settings.value?.account;

  if (!account) {
    return '登录后可维护用户名、展示名称和模型 API 配置。';
  }

  const identity = account.email || account.username || account.id;
  return `当前账号：${identity}`;
});

function applyAccountForm(account: AccountSetting) {
  accountForm.username = account.username ?? '';
  accountForm.displayName = account.displayName;
}

function applyApiForm(apiSetting: ApiSetting | null) {
  apiForm.provider = apiSetting?.provider ?? 'anthropic';
  apiForm.model = apiSetting?.model ?? 'claude-sonnet-4-5';
  apiForm.baseUrl = apiSetting?.baseUrl ?? 'https://api.anthropic.com';
  apiForm.apiKey = '';
  imageForm.imageUrl = apiSetting?.imageUrl ?? '';
  imageForm.imageKey = '';
  imageForm.imageDefaultModel = apiSetting?.imageDefaultModel ?? '';
  imageForm.imageModels = apiSetting?.imageModels?.join(', ') ?? '';
  videoForm.videoUrl = apiSetting?.videoUrl ?? '';
  videoForm.videoKey = '';
  videoForm.videoDefaultModel = apiSetting?.videoDefaultModel ?? '';
  videoForm.videoModels = apiSetting?.videoModels?.join(', ') ?? '';
}

function syncForms(nextSettings: UserSettings) {
  applyAccountForm(nextSettings.account);
  applyApiForm(nextSettings.apiSettings[0] ?? null);
}

function applyGithubMcpForm(setting: GithubMcpSetting) {
  githubMcpSetting.value = setting;
  githubMcpForm.enabled = setting.enabled;
  githubMcpForm.personalAccessToken = '';
}

function formatDate(value: string | null) {
  if (!value) {
    return '未记录';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
}

function setSuccess(message: string) {
  successMessage.value = message;
  errorMessage.value = null;
}

function setFailure(error: unknown, fallbackMessage: string) {
  successMessage.value = null;
  errorMessage.value = error instanceof Error ? error.message : fallbackMessage;
}

async function loadSettings() {
  loadStatus.value = 'loading';
  errorMessage.value = null;

  try {
    const [nextSettings, nextGithubMcpSetting] = await Promise.all([
      settingsClient.getSettings(),
      settingsClient.getGithubMcpSetting(),
    ]);
    settings.value = nextSettings;
    syncForms(nextSettings);
    applyGithubMcpForm(nextGithubMcpSetting);
    loadStatus.value = 'ready';
  } catch (error) {
    loadStatus.value = 'error';
    setFailure(error, '设置加载失败。');
  }
}

async function saveAccount() {
  const username = accountForm.username.trim();

  if (!username) {
    errorMessage.value = '用户名不能为空。';
    successMessage.value = null;
    return;
  }

  accountSaveStatus.value = 'loading';

  try {
    const account = await settingsClient.updateUsername({
      username,
      displayName: accountForm.displayName.trim() || undefined,
    });
    const nextSettings = {
      account,
      apiSettings: settings.value?.apiSettings ?? [],
    };

    settings.value = nextSettings;
    applyAccountForm(account);

    if (session.value) {
      authStore.setSession({
        ...session.value,
        user: {
          ...session.value.user,
          id: account.id,
          email: account.email,
          username: account.username,
          displayName: account.displayName,
        },
      });
    }

    accountSaveStatus.value = 'ready';
    setSuccess('账号信息已更新。');
  } catch (error) {
    accountSaveStatus.value = 'error';
    setFailure(error, '账号信息保存失败。');
  }
}

async function saveApiSetting() {
  apiSaveStatus.value = 'loading';

  try {
    const apiSetting = await settingsClient.upsertApiSetting({
      provider: apiForm.provider.trim() || 'anthropic',
      model: apiForm.model.trim() || undefined,
      baseUrl: apiForm.baseUrl.trim() || undefined,
      apiKey: apiForm.apiKey.trim() || undefined,
    });

    settings.value = {
      account: settings.value?.account ?? {
        id: session.value?.user.id ?? '1',
        email: session.value?.user.email ?? null,
        username: session.value?.user.username ?? null,
        displayName: session.value?.user.displayName ?? '用户',
        createdAt: null,
        updatedAt: null,
      },
      apiSettings: [
        apiSetting,
        ...(settings.value?.apiSettings ?? []).filter((item) => item.id !== apiSetting.id),
      ],
    };
    applyApiForm(apiSetting);
    apiSaveStatus.value = 'ready';
    setSuccess('API 配置已保存。');
  } catch (error) {
    apiSaveStatus.value = 'error';
    setFailure(error, 'API 配置保存失败。');
  }
}

async function testApiSetting() {
  apiTestStatus.value = 'loading';
  testResult.value = null;

  try {
    const result = await settingsClient.testApiSetting({
      provider: apiForm.provider.trim() || 'anthropic',
      model: apiForm.model.trim() || undefined,
      baseUrl: apiForm.baseUrl.trim() || undefined,
      apiKey: apiForm.apiKey.trim() || undefined,
    });

    testResult.value = result;
    apiTestStatus.value = result.ok ? 'ready' : 'error';

    if (result.ok) {
      setSuccess('API 连接测试通过。');
    } else {
      errorMessage.value = result.message;
      successMessage.value = null;
    }
  } catch (error) {
    apiTestStatus.value = 'error';
    setFailure(error, 'API 连接测试失败。');
  }
}

async function saveMultimodalSetting() {
  multimodalSaveStatus.value = 'loading';

  try {
    const apiSetting = await settingsClient.upsertApiSetting({
      imageUrl: imageForm.imageUrl.trim() || undefined,
      imageKey: imageForm.imageKey.trim() || undefined,
      imageDefaultModel: imageForm.imageDefaultModel.trim() || undefined,
      imageModels: imageForm.imageModels.trim() || undefined,
      videoUrl: videoForm.videoUrl.trim() || undefined,
      videoKey: videoForm.videoKey.trim() || undefined,
      videoDefaultModel: videoForm.videoDefaultModel.trim() || undefined,
      videoModels: videoForm.videoModels.trim() || undefined,
    });

    settings.value = {
      account: settings.value?.account ?? {
        id: session.value?.user.id ?? '1',
        email: session.value?.user.email ?? null,
        username: session.value?.user.username ?? null,
        displayName: session.value?.user.displayName ?? '用户',
        createdAt: null,
        updatedAt: null,
      },
      apiSettings: [
        apiSetting,
        ...(settings.value?.apiSettings ?? []).filter((item) => item.id !== apiSetting.id),
      ],
    };
    applyApiForm(apiSetting);
    multimodalSaveStatus.value = 'ready';
    setSuccess('多模态配置已保存。');
  } catch (error) {
    multimodalSaveStatus.value = 'error';
    setFailure(error, '多模态配置保存失败。');
  }
}

async function saveGithubMcpSetting() {
  githubMcpSaveStatus.value = 'loading';
  try {
    const setting = await settingsClient.saveGithubMcpSetting({
      enabled: githubMcpForm.enabled,
      personalAccessToken: githubMcpForm.personalAccessToken.trim() || undefined,
    });
    applyGithubMcpForm(setting);
    githubMcpTestResult.value = null;
    githubMcpSaveStatus.value = 'ready';
    setSuccess('GitHub MCP 配置已保存；会在首次测试或对话时连接。');
  } catch (error) {
    githubMcpSaveStatus.value = 'error';
    setFailure(error, 'GitHub MCP 配置保存失败。');
  }
}

async function testGithubMcpSetting() {
  githubMcpTestStatus.value = 'loading';
  githubMcpTestResult.value = null;
  try {
    const result = await settingsClient.testGithubMcpSetting(
      githubMcpForm.personalAccessToken.trim() || undefined,
    );
    githubMcpTestResult.value = result;
    githubMcpTestStatus.value = result.ok ? 'ready' : 'error';
    if (result.ok) {
      setSuccess('GitHub MCP 握手、工具发现和 get_me 调用均已通过。');
    } else {
      errorMessage.value = result.message;
      successMessage.value = null;
    }
  } catch (error) {
    githubMcpTestStatus.value = 'error';
    setFailure(error, 'GitHub MCP 连接测试失败。');
  }
}

async function deleteGithubMcpSetting() {
  githubMcpDeleteStatus.value = 'loading';
  try {
    const setting = await settingsClient.deleteGithubMcpSetting();
    applyGithubMcpForm(setting);
    githubMcpTestResult.value = null;
    githubMcpDeleteStatus.value = 'ready';
    setSuccess('GitHub MCP 配置已删除，运行时连接已释放。');
  } catch (error) {
    githubMcpDeleteStatus.value = 'error';
    setFailure(error, 'GitHub MCP 配置删除失败。');
  }
}

onMounted(() => {
  void loadSettings();
});
</script>

<template>
  <section class="page-section">
    <header class="page-header">
      <div class="page-heading">
        <MobileRailTrigger />
        <div>
          <p class="eyebrow">设置</p>
          <h1>个人中心</h1>
          <p class="page-subtitle">{{ accountMeta }}</p>
        </div>
      </div>
      <button type="button" class="ghost-button" :disabled="isLoading" @click="loadSettings">
        {{ isLoading ? '刷新中...' : '刷新' }}
      </button>
    </header>

    <p v-if="errorMessage" class="feedback error" aria-live="polite">{{ errorMessage }}</p>
    <p v-else-if="successMessage" class="feedback success" aria-live="polite">{{ successMessage }}</p>

    <section v-if="isLoading && !settings" class="settings-card">
      <p class="muted">正在加载个人中心数据...</p>
    </section>

    <template v-else>
      <section class="settings-grid">
        <article class="settings-card account-card">
          <div class="section-heading">
            <div>
              <p class="eyebrow">Account</p>
              <h2>账号信息</h2>
            </div>
          </div>

          <form class="settings-form" @submit.prevent="saveAccount">
            <label class="field-block">
              <span>用户名</span>
              <input v-model="accountForm.username" type="text" autocomplete="username" placeholder="new_user" />
            </label>
            <label class="field-block">
              <span>展示名称</span>
              <input v-model="accountForm.displayName" type="text" autocomplete="name" placeholder="用于界面展示" />
            </label>
            <button type="submit" class="primary-button" :disabled="isSavingAccount">
              {{ isSavingAccount ? '保存中...' : '保存账号信息' }}
            </button>
          </form>
        </article>

        <article class="settings-card profile-card">
          <div class="section-heading">
            <div>
              <p class="eyebrow">Profile</p>
              <h2>当前账号</h2>
            </div>
          </div>

          <dl class="detail-list">
            <div>
              <dt>用户 ID</dt>
              <dd>{{ settings?.account.id ?? session?.user.id ?? '-' }}</dd>
            </div>
            <div>
              <dt>邮箱</dt>
              <dd>{{ settings?.account.email ?? '未绑定' }}</dd>
            </div>
            <div>
              <dt>创建时间</dt>
              <dd>{{ formatDate(settings?.account.createdAt ?? null) }}</dd>
            </div>
            <div>
              <dt>更新时间</dt>
              <dd>{{ formatDate(settings?.account.updatedAt ?? null) }}</dd>
            </div>
          </dl>
        </article>
      </section>

      <section class="settings-card api-card">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Model API</p>
            <h2>Model API 配置</h2>
          </div>
          <span class="api-key-badge" :class="{ configured: primaryApiSetting?.hasApiKey }">
            {{ primaryApiSetting?.hasApiKey ? `已保存 ${primaryApiSetting.apiKeyHint ?? ''}` : '未保存 Key' }}
          </span>
        </div>

        <form class="settings-form api-form" @submit.prevent="saveApiSetting">
          <label class="field-block">
            <span>Provider</span>
            <select v-model="apiForm.provider">
              <option value="anthropic">Anthropic Messages</option>
              <option value="openai">OpenAI Chat Completions</option>
              <option value="openrouter">OpenRouter (OpenAI compatible)</option>
            </select>
          </label>
          <label class="field-block">
            <span>模型</span>
            <input v-model="apiForm.model" type="text" placeholder="claude-sonnet-4-5" />
          </label>
          <label class="field-block wide-field">
            <span>Base URL</span>
            <input v-model="apiForm.baseUrl" type="url" placeholder="https://api.anthropic.com" />
          </label>
          <label class="field-block wide-field">
            <span>API Key</span>
            <input
              v-model="apiForm.apiKey"
              type="password"
              autocomplete="off"
              placeholder="留空则保留已保存 Key"
            />
          </label>

          <div class="button-row">
            <button type="button" class="ghost-button" :disabled="isTestingApi" @click="testApiSetting">
              {{ isTestingApi ? '测试中...' : '测试连接' }}
            </button>
            <button type="submit" class="primary-button" :disabled="isSavingApi">
              {{ isSavingApi ? '保存中...' : '保存 API 配置' }}
            </button>
          </div>
        </form>

        <div v-if="testResult" class="test-result" :class="{ ok: testResult.ok }">
          <strong>{{ testResult.ok ? '连接成功' : '连接失败' }}</strong>
          <span>{{ testResult.message }}</span>
          <code>{{ testResult.provider }} · {{ testResult.model }} · {{ testResult.status ?? 'no status' }}</code>
        </div>
      </section>

      <section class="settings-card multimodal-card">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Multimodal API</p>
            <h2>图片 / 视频生成</h2>
          </div>
          <div class="multimodal-key-badges">
            <span class="api-key-badge" :class="{ configured: primaryApiSetting?.hasImageKey }">
              图片 {{ primaryApiSetting?.hasImageKey ? `已保存 ${primaryApiSetting.imageKeyHint ?? ''}` : '未配置' }}
            </span>
            <span class="api-key-badge" :class="{ configured: primaryApiSetting?.hasVideoKey }">
              视频 {{ primaryApiSetting?.hasVideoKey ? `已保存 ${primaryApiSetting.videoKeyHint ?? ''}` : '未配置' }}
            </span>
          </div>
        </div>

        <form class="settings-form multimodal-form" @submit.prevent="saveMultimodalSetting">
          <p class="multimodal-hint">
            图片和视频生成使用独立的 API 端点，通常填写 OpenRouter 等多模态代理的地址。
            留空 Key 字段则保留已保存的值。
          </p>

          <div class="multimodal-section-label">图片生成</div>

          <label class="field-block">
            <span>图片 Base URL</span>
            <input
              v-model="imageForm.imageUrl"
              type="url"
              placeholder="https://openrouter.ai/api"
            />
          </label>
          <label class="field-block">
            <span>图片 API Key</span>
            <input
              v-model="imageForm.imageKey"
              type="password"
              autocomplete="off"
              placeholder="留空则保留已保存 Key"
            />
          </label>
          <label class="field-block">
            <span>默认模型</span>
            <input
              v-model="imageForm.imageDefaultModel"
              type="text"
              placeholder="bytedance-seed/seedream-4.5"
            />
          </label>
          <label class="field-block">
            <span>可用模型（逗号分隔）</span>
            <input
              v-model="imageForm.imageModels"
              type="text"
              placeholder="bytedance-seed/seedream-4.5, ..."
            />
          </label>

          <div class="multimodal-section-label">视频生成</div>

          <label class="field-block">
            <span>视频 Base URL</span>
            <input
              v-model="videoForm.videoUrl"
              type="url"
              placeholder="https://openrouter.ai/api"
            />
          </label>
          <label class="field-block">
            <span>视频 API Key</span>
            <input
              v-model="videoForm.videoKey"
              type="password"
              autocomplete="off"
              placeholder="留空则保留已保存 Key"
            />
          </label>
          <label class="field-block">
            <span>默认模型</span>
            <input
              v-model="videoForm.videoDefaultModel"
              type="text"
              placeholder="alibaba/wan-2.6"
            />
          </label>
          <label class="field-block">
            <span>可用模型（逗号分隔）</span>
            <input
              v-model="videoForm.videoModels"
              type="text"
              placeholder="alibaba/wan-2.6, ..."
            />
          </label>

          <div class="button-row wide-field">
            <button type="submit" class="primary-button" :disabled="isSavingMultimodal">
              {{ isSavingMultimodal ? '保存中...' : '保存多模态配置' }}
            </button>
          </div>
        </form>
      </section>

      <section class="settings-card mcp-card">
        <div class="section-heading">
          <div>
            <p class="eyebrow">MCP</p>
            <h2>GitHub MCP</h2>
          </div>
          <div class="multimodal-key-badges">
            <span class="api-key-badge" :class="{ configured: githubMcpSetting?.configured }">
              {{ githubMcpSetting?.configured ? `PAT 已保存 ${githubMcpSetting.tokenHint ?? ''}` : '未保存 PAT' }}
            </span>
            <span class="api-key-badge" :class="{ configured: githubMcpSetting?.status === 'connected' }">
              {{ githubMcpSetting?.status ?? 'not_configured' }}
            </span>
          </div>
        </div>

        <form class="settings-form mcp-form" @submit.prevent="saveGithubMcpSetting">
          <p class="mcp-hint">
            固定连接 GitHub 官方远程 MCP，仅启用 context、repos 工具集并强制只读。
            配置按当前用户持久化；PAT 留空表示保留已保存值。
          </p>
          <label class="toggle-field">
            <input v-model="githubMcpForm.enabled" type="checkbox" />
            <span>允许对话和 Skill 使用 GitHub MCP</span>
          </label>
          <label class="field-block wide-field">
            <span>GitHub Personal Access Token</span>
            <input
              v-model="githubMcpForm.personalAccessToken"
              type="password"
              autocomplete="off"
              placeholder="github_pat_...（留空保留已保存 PAT）"
            />
          </label>
          <div class="mcp-endpoint wide-field">
            <span>官方端点</span>
            <code>{{ githubMcpSetting?.endpoint ?? 'https://api.githubcopilot.com/mcp/' }}</code>
          </div>
          <div class="button-row wide-field mcp-button-row">
            <button
              v-if="githubMcpSetting?.configured"
              type="button"
              class="danger-button"
              :disabled="isDeletingGithubMcp"
              @click="deleteGithubMcpSetting"
            >
              {{ isDeletingGithubMcp ? '删除中...' : '删除配置' }}
            </button>
            <span class="button-spacer" />
            <button type="button" class="ghost-button" :disabled="isTestingGithubMcp" @click="testGithubMcpSetting">
              {{ isTestingGithubMcp ? '测试中...' : '测试连接' }}
            </button>
            <button type="submit" class="primary-button" :disabled="isSavingGithubMcp">
              {{ isSavingGithubMcp ? '保存中...' : '保存 GitHub MCP' }}
            </button>
          </div>
        </form>

        <div v-if="githubMcpTestResult" class="test-result" :class="{ ok: githubMcpTestResult.ok }">
          <strong>{{ githubMcpTestResult.ok ? '独立测试通过' : '独立测试失败' }}</strong>
          <span>{{ githubMcpTestResult.message }}</span>
          <code v-if="githubMcpTestResult.githubUser?.login">
            GitHub 用户：{{ githubMcpTestResult.githubUser.login }}<template v-if="githubMcpTestResult.githubUser.name">（{{ githubMcpTestResult.githubUser.name }}）</template>
          </code>
          <span>发现 {{ githubMcpTestResult.toolCount }} 个只读工具</span>
          <details v-if="githubMcpTestResult.toolNames.length" class="mcp-tool-list">
            <summary>查看工具名称</summary>
            <code v-for="toolName in githubMcpTestResult.toolNames" :key="toolName">{{ toolName }}</code>
          </details>
        </div>

        <p v-else-if="githubMcpSetting?.lastError" class="mcp-runtime-error">
          上次连接错误：{{ githubMcpSetting.lastError }}
        </p>
      </section>

      <section class="settings-card runtime-card">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Runtime</p>
            <h2>联调状态</h2>
          </div>
        </div>

        <div class="runtime-grid">
          <div>
            <span>客户端模式</span>
            <strong>{{ runtimeConfig.clientMode === 'mock' ? '离线 Mock' : '上游联调' }}</strong>
          </div>
          <div>
            <span>API 基础地址</span>
            <strong>{{ runtimeConfig.apiBaseUrl ?? '未配置' }}</strong>
          </div>
          <div>
            <span>默认用户 ID</span>
            <strong>{{ runtimeConfig.userId }}</strong>
          </div>
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped>
@import './shared-page.css';

.page-subtitle,
.muted {
  margin: 6px 0 0;
  color: var(--color-text-muted);
  line-height: 1.45;
}

.ghost-button,
.primary-button,
.danger-button {
  min-height: 40px;
  border-radius: 10px;
  padding: 0 14px;
  cursor: pointer;
  font-weight: 800;
}

.ghost-button {
  border: 1px solid var(--color-border);
  background: var(--color-surface-strong);
  color: var(--color-text);
}

.primary-button {
  border: 0;
  background: var(--color-primary);
  color: var(--color-on-primary);
}

.danger-button {
  border: 1px solid color-mix(in srgb, var(--color-danger) 36%, var(--color-border));
  background: var(--color-surface-strong);
  color: var(--color-danger);
}

.ghost-button:disabled,
.primary-button:disabled,
.danger-button:disabled {
  cursor: wait;
  opacity: 0.64;
}

.feedback {
  margin: 0;
  padding: 12px 14px;
  border-radius: 14px;
  line-height: 1.45;
}

.feedback.error {
  border: 1px solid color-mix(in srgb, var(--color-danger) 26%, var(--color-border));
  background: color-mix(in srgb, var(--color-warning-soft) 58%, white);
  color: var(--color-danger);
}

.feedback.success {
  border: 1px solid color-mix(in srgb, var(--color-primary) 24%, var(--color-border));
  background: color-mix(in srgb, var(--color-primary-soft) 58%, white);
  color: var(--color-text);
}

.settings-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(260px, 0.8fr);
  gap: 12px;
}

.settings-card {
  padding: 18px;
  border: 1px solid var(--color-border);
  border-radius: 18px;
  background: var(--color-surface);
  box-shadow: var(--shadow-card);
}

.section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}

h2 {
  margin: 0;
  color: var(--color-text);
  font-family: var(--font-display);
  font-size: 1.08rem;
  line-height: 1.15;
}

.settings-form {
  display: grid;
  gap: 14px;
}

.api-form {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.field-block {
  display: grid;
  gap: 8px;
  color: var(--color-text);
  font-weight: 750;
}

.field-block span {
  color: var(--color-text-muted);
  font-size: 0.82rem;
}

.field-block input,
.field-block select {
  width: 100%;
  min-height: 42px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-surface-strong);
  color: var(--color-text);
  padding: 0 13px;
}

.field-block input:focus,
.field-block select:focus {
  border-color: color-mix(in srgb, var(--color-primary) 44%, var(--color-border));
  outline: 3px solid var(--color-focus-ring);
}

.wide-field,
.button-row,
.test-result {
  grid-column: 1 / -1;
}

.button-row {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.detail-list {
  display: grid;
  gap: 12px;
  margin: 0;
}

.detail-list div,
.runtime-grid div {
  display: grid;
  gap: 4px;
  padding: 12px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--color-bg-subtle) 66%, white);
}

.detail-list dt,
.runtime-grid span {
  color: var(--color-text-muted);
  font-size: 0.76rem;
  font-weight: 800;
}

.detail-list dd,
.runtime-grid strong {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--color-text);
}

.api-key-badge {
  flex: 0 0 auto;
  padding: 6px 10px;
  border-radius: 999px;
  background: var(--color-bg-subtle);
  color: var(--color-text-muted);
  font-size: 0.78rem;
  font-weight: 800;
}

.api-key-badge.configured {
  background: color-mix(in srgb, var(--color-primary-soft) 78%, white);
  color: var(--color-primary);
}

.test-result {
  display: grid;
  gap: 5px;
  margin-top: 14px;
  padding: 12px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--color-danger) 22%, var(--color-border));
  background: color-mix(in srgb, var(--color-warning-soft) 48%, white);
  color: var(--color-text);
}

.test-result.ok {
  border-color: color-mix(in srgb, var(--color-primary) 22%, var(--color-border));
  background: color-mix(in srgb, var(--color-primary-soft) 56%, white);
}

.test-result span {
  color: var(--color-text-muted);
}

.test-result code {
  color: var(--color-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow-wrap: anywhere;
}

.runtime-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.multimodal-form {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.multimodal-hint {
  grid-column: 1 / -1;
  margin: 0 0 4px;
  color: var(--color-text-muted);
  font-size: 0.84rem;
  line-height: 1.5;
}

.multimodal-section-label {
  grid-column: 1 / -1;
  margin-top: 6px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text);
  font-size: 0.82rem;
  font-weight: 800;
}

.multimodal-key-badges {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.mcp-form {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.mcp-hint {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--color-text-muted);
  font-size: 0.84rem;
  line-height: 1.5;
}

.toggle-field {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--color-text);
  font-weight: 750;
}

.toggle-field input {
  width: 18px;
  height: 18px;
  accent-color: var(--color-primary);
}

.mcp-endpoint {
  display: grid;
  gap: 5px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--color-bg-subtle);
}

.mcp-endpoint span {
  color: var(--color-text-muted);
  font-size: 0.76rem;
  font-weight: 800;
}

.mcp-endpoint code,
.mcp-tool-list code {
  overflow-wrap: anywhere;
  color: var(--color-text);
}

.mcp-button-row .button-spacer {
  flex: 1;
}

.mcp-tool-list {
  display: grid;
  gap: 7px;
}

.mcp-tool-list summary {
  cursor: pointer;
  font-weight: 800;
}

.mcp-tool-list code {
  display: block;
  padding: 5px 8px;
  border-radius: 7px;
  background: var(--color-surface-strong);
}

.mcp-runtime-error {
  margin: 14px 0 0;
  color: var(--color-danger);
  font-size: 0.84rem;
}

@media (max-width: 960px) {
  .settings-grid,
  .api-form,
  .multimodal-form,
  .mcp-form,
  .runtime-grid {
    grid-template-columns: 1fr;
  }

  .button-row {
    flex-direction: column;
  }
}
</style>
