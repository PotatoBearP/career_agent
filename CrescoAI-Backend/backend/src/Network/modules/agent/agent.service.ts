import { Injectable, Optional } from '@nestjs/common';
import {
  AgentAttachmentInput,
  AgentConversationMetadata,
  AgentCreateConversationInput,
  AgentMessageBlock,
  AgentSendMessageInput,
  AgentSendMessageResult,
  AgentStreamEvent,
  type GeneratedFile,
  createConversation,
} from './agent.runtime';
import { extractAskUserQuestions } from './ask-user-question.js';
import {
  runWithSessionContext,
  type SessionContext,
  type ToolResponsePayload,
} from '../../../server/SessionContext.js';
import { createIsolatedState } from '../../../bootstrap/state.js';
import { createQueryEngineForSession } from '../../../server/queryEngineFactory.js';
import {
  getNetworkSharedReadOnlyRoots,
  getNetworkTrustedSkillCatalogRoots,
} from '../../../server/networkFilesystemPolicy.js';
import { NETWORK_READ_ONLY_FILE_TOOLS } from '../../../server/filesystemPolicyTypes.js';
import { QueryEngine } from '../../../QueryEngine.js';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SettingsService } from '../settings/settings.service';
import { setSessionMultimodalConfig, removeSessionMultimodalConfig } from '../../../utils/multimodalConfig.js';
import { discoverGeneratedFiles } from './generated-output-discovery.js';
import { sanitizeServerPhysicalPaths } from '../../utils/publicOutputSanitizer.js';
import { getCommands } from '../../../commands.js';
import { flushSessionStorage } from '../../../utils/sessionStorage.js';
import {
  appendNetworkTranscriptEvent,
  ensureNetworkUserWorkspaceDir,
  ensureNetworkTranscriptDir,
  getNetworkAutoMemoryDir,
  getNetworkConversationMemoryDir,
  getNetworkConversationMemorySessionPath,
  getNetworkTranscriptDir,
  getNetworkUserFilesDir,
  getNetworkUserWorkspaceDir,
  networkRootDir,
} from '../../utils/networkTranscriptStorage.js';
import { prepareConversationMemoryTurn } from '../../memory/conversationMemoryRuntime.js';
import {
  isConversationMemoryMaintenanceMessage,
  isConversationMemorySdkReminder,
  isInternalSdkMessage,
  shouldSuppressConversationMemoryBlock,
} from '../../memory/conversationMemoryVisibility.js';
import {
  collectConversationMemoryPrivateIdentifiers,
  sanitizeConversationMemoryPublicText,
  sanitizeConversationMemoryPublicValue,
} from '../../memory/conversationMemoryPublicPolicy.js';
import {
  createSkillLoadedBlock,
  extractLoadedSkillNameFromText,
  normalizeCanonicalMessageBlocks,
  THINKING_BLOCK_TITLE,
} from '../conversation/canonical-message-blocks.js';
import { ProfileV2Service } from '../profile/profile-v2.service';
import { ProfileMemoryService } from '../profile/profile-memory.service';
import { ProfileProposalService } from '../profile/profile-proposal.service';
import { createProfileTools } from '../profile/profile.tools';
import { ProfileRecallService } from '../profile/profile-recall.service';
import { ProfileProductProjectionService } from '../profile/profile-product-projection.service';
import { ProfileProductMutationService } from '../profile/profile-product-mutation.service';
import { ProfileEvidenceService } from '../profile/profile-evidence.service';
import {
  decodeProfileProductMemoryValue,
  isListProfileProductCodec,
  listProfileProductFieldDefinitions,
} from '../profile/profile-product-field.registry';
import { listProfileEvidenceCandidates } from '../../memory/conversationMemoryIndex.js';
import { loadAgentSessionHistory } from './agent-session-recovery.js';
import type { Tool } from '../../../Tool.js';
import { GithubMcpRuntimeService, type GithubMcpRuntimeSnapshot } from '../settings/github-mcp-runtime.service';
import {
  drainSkillLifecycleEvents,
  finalizeAllActiveSkillInvocations,
} from '../../../skills/skillLifecycle.js';
import type { SkillCompletedEvent } from '../../../skills/skillLifecycleTypes.js';

// ---------------------------------------------------------------------------
// JSONL helpers
// ---------------------------------------------------------------------------

async function appendJsonlEvent(
  userId: string,
  conversationId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await appendNetworkTranscriptEvent(userId, conversationId, payload);
}

function createAssistantProcessBlock(thinking: string): Record<string, unknown> {
  return {
    type: 'thinking',
    phase: 'process',
    thinking: sanitizeServerPhysicalPaths(thinking),
    signature: '',
  };
}

function createAssistantFinalBlock(text: string): Record<string, unknown> {
  return {
    type: 'text',
    phase: 'final',
    text: sanitizeServerPhysicalPaths(text),
  };
}

function formatAgentProcessBlock(block: Record<string, unknown>): string {
  const blockType = typeof block.type === 'string' ? block.type : 'unknown';

  if (blockType === 'thinking' && typeof block.thinking === 'string') {
    return sanitizeServerPhysicalPaths(block.thinking);
  }

  if (blockType === 'reasoning' && typeof (block.reasoning ?? block.text) === 'string') {
    return sanitizeServerPhysicalPaths(String(block.reasoning ?? block.text));
  }

  if (blockType === 'text') {
    return '';
  }

  if (isToolFacingProcessBlock(blockType, block)) {
    return formatFilteredToolProcessBlock(blockType, block);
  }

  return formatFilteredStructuredProcessBlock(blockType);
}

function isToolResultProcessBlock(blockType: string, block: Record<string, unknown>): boolean {
  return (
    blockType === 'tool_result' ||
    blockType.endsWith('_tool_result') ||
    typeof block.tool_use_id === 'string' ||
    typeof block.toolUseId === 'string' ||
    block.result !== undefined ||
    block.output !== undefined ||
    block.error !== undefined
  );
}

function isToolFacingProcessBlock(blockType: string, block: Record<string, unknown>): boolean {
  return (
    blockType === 'tool_use' ||
    blockType === 'tool_result' ||
    blockType === 'server_tool_use' ||
    blockType === 'mcp_tool_use' ||
    blockType.endsWith('_tool_use') ||
    blockType.endsWith('_tool_result') ||
    typeof block.tool_use_id === 'string' ||
    typeof block.toolUseId === 'string'
  );
}

function formatFilteredToolProcessBlock(
  blockType: string,
  block: Record<string, unknown>,
): string {
  if (isToolResultProcessBlock(blockType, block)) {
    return formatSanitizedToolResultProcessBlock(block);
  }

  return [
    '[工具调用]',
    '正在调用工具。',
  ].join('\n');
}

function formatSanitizedToolResultProcessBlock(block: Record<string, unknown>): string {
  const rawResult = extractToolResultText(block);
  const resultText = redactSensitiveProcessText(rawResult);
  return [
    '[工具返回]',
    resultText || (block.is_error === true || block.isError === true ? '工具返回错误。' : '工具已返回。'),
  ].join('\n');
}

function extractToolResultText(block: Record<string, unknown>): string {
  const value = block.content ?? block.result ?? block.output ?? block.error ?? block;
  return stringifyToolResultValue(value);
}

function stringifyToolResultValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (typeof item !== 'object' || item === null) {
          return String(item);
        }
        const typedItem = item as Record<string, unknown>;
        if (typedItem.type === 'text' && typeof typedItem.text === 'string') {
          return typedItem.text;
        }
        if (typeof typedItem.content === 'string') {
          return typedItem.content;
        }
        return stringifyToolResultValue(typedItem);
      })
      .filter(Boolean)
      .join('\n');
  }

  if (value === undefined || value === null) {
    return '';
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractLoadedSkillNameFromSdkMessage(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;

  const record = value as Record<string, unknown>;
  const message = typeof record.message === 'object' && record.message !== null
    ? record.message as Record<string, unknown>
    : null;
  if (!message) return null;

  const content = message.content;
  if (record.isMeta === true) {
    return extractLoadedSkillNameFromText(stringifyToolResultValue(content));
  }

  for (const block of Array.isArray(content) ? content : []) {
    if (typeof block !== 'object' || block === null) continue;
    const typedBlock = block as Record<string, unknown>;
    if (typedBlock.type !== 'tool_result') continue;
    const skillName = extractLoadedSkillNameFromText(
      stringifyToolResultValue(typedBlock.content),
    );
    if (skillName) return skillName;
  }
  return null;
}

function extractSkillNameFromToolUseBlock(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const block = value as Record<string, unknown>;
  const blockType = typeof block.type === 'string' ? block.type : '';
  const toolName = typeof block.name === 'string' ? block.name.trim().toLowerCase() : '';
  if (!blockType.endsWith('tool_use')) return null;
  if (toolName !== 'skill') return null;
  const input = typeof block.input === 'object' && block.input !== null
    ? block.input as Record<string, unknown>
    : null;
  return typeof input?.skill === 'string' && input.skill.trim()
    ? input.skill.trim()
    : null;
}

function redactSensitiveProcessText(input: string): string {
  let output = input;
  output = output.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1******');
  output = output.replace(
    /\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|pwd|private[_-]?key)\b(\s*[:=]\s*)(["']?)[^\s"',;]+/gi,
    '$1$2$3******',
  );
  output = output.replace(
    /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)=)[^&\s"']+/gi,
    '$1******',
  );
  output = output.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '******');
  output = output.replace(/\b(?:sk|pk|rk|xox[baprs])-[A-Za-z0-9_-]{16,}\b/gi, '******');
  output = output.replace(/\b[A-Fa-f0-9]{64,}\b/g, '******');
  output = output.replace(/\b[A-Za-z0-9+/]{80,}={0,2}\b/g, '******');
  output = output.replace(/C:\\Users\\[^\\\s"']+/gi, 'C:\\Users\\<user>');
  return sanitizeServerPhysicalPaths(output);
}

function formatFilteredStructuredProcessBlock(blockType: string): string {
  return [
    '[过程事件]',
    '正在处理过程事件。',
  ].join('\n');
}

function readBlockString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readToolUseId(block: Record<string, unknown>): string | null {
  return readBlockString(block.id ?? block.tool_use_id ?? block.toolUseId);
}

function readToolName(block: Record<string, unknown>): string | null {
  return readBlockString(block.name ?? block.tool_name ?? block.toolName);
}

function createTextAgentBlock(id: string, text = ''): AgentMessageBlock {
  return {
    id,
    type: 'text',
    text: sanitizeServerPhysicalPaths(text),
  };
}

function createStatusAgentBlock(
  id: string,
  text: string,
  title = THINKING_BLOCK_TITLE,
): AgentMessageBlock {
  return {
    id,
    type: 'status',
    title,
    text: sanitizeServerPhysicalPaths(text),
  };
}

function sanitizeConversationMemoryAgentText(
  input: string,
  context: SessionContext,
): string {
  return sanitizeConversationMemoryPublicText(
    sanitizeServerPhysicalPaths(input),
    context.conversationMemoryTurn?.privateConversationIds,
  );
}

function sanitizeConversationMemoryAgentBlock(
  block: AgentMessageBlock,
  context: SessionContext,
): AgentMessageBlock {
  return sanitizeConversationMemoryPublicValue(
    block,
    context.conversationMemoryTurn?.privateConversationIds,
  );
}

function registerConversationMemoryAgentIdentifiers(
  value: unknown,
  context: SessionContext,
): void {
  const privateIds = context.conversationMemoryTurn?.privateConversationIds;
  if (!privateIds) return;
  for (const identifier of collectConversationMemoryPrivateIdentifiers(value)) {
    privateIds.add(identifier);
  }
}

function createPublicAgentBlockFromContentBlock(
  block: Record<string, unknown>,
  index: number,
): AgentMessageBlock | null {
  const blockType = typeof block.type === 'string' ? block.type : '';

  if (blockType === 'text') {
    const text = readBlockString(block.text ?? block.content);
    return text ? createTextAgentBlock(`text-${index}`, text) : null;
  }

  if (isToolResultProcessBlock(blockType, block)) {
    const toolName = readToolName(block);
    const toolUseId = readToolUseId(block);
    const resultText = redactSensitiveProcessText(extractToolResultText(block)).trim();
    return {
      id: toolUseId ? `tool-result-${toolUseId}` : `tool-result-${index}`,
      type: 'tool_result',
      title: toolName ? `工具返回 · ${toolName}` : '工具返回',
      name: toolName,
      toolUseId,
      text: resultText || (block.is_error === true || block.isError === true ? '工具返回错误。' : '工具已返回。'),
      isError: block.is_error === true || block.isError === true,
    };
  }

  if (isToolFacingProcessBlock(blockType, block)) {
    const toolName = readToolName(block);
    const toolUseId = readToolUseId(block);
    const questions = extractAskUserQuestions(block);
    if (questions) {
      return {
        id: toolUseId ? `ask-question-${toolUseId}` : `ask-question-${index}`,
        type: 'ask_question',
        title: '需要你的选择',
        name: toolName,
        toolUseId,
        status: 'pending',
        text: '请回答以下问题，以便继续。',
        questions,
      };
    }
    return {
      id: toolUseId ? `tool-call-${toolUseId}` : `tool-call-${index}`,
      type: 'tool_call',
      title: toolName ? `工具调用 · ${toolName}` : '工具调用',
      name: toolName,
      toolUseId,
      status: 'completed',
      text: toolName ? `正在调用 ${toolName}。` : '正在调用工具。',
    };
  }

  if (blockType === 'thinking' || blockType === 'reasoning') {
    const text = readBlockString(block.thinking ?? block.reasoning ?? block.text ?? block.content);
    return text ? createStatusAgentBlock(`status-${index}`, text) : null;
  }

  if (blockType === 'redacted_thinking') {
    return createStatusAgentBlock(`status-${index}`, '思考内容已脱敏。');
  }

  const processText = formatAgentProcessBlock(block);
  return processText ? createStatusAgentBlock(`status-${index}`, processText) : null;
}

function mergeAgentBlock(blocks: AgentMessageBlock[], block: AgentMessageBlock): AgentMessageBlock[] {
  const index = blocks.findIndex((item) => item.id === block.id);
  if (index < 0) {
    return [...blocks, block];
  }

  const nextBlocks = [...blocks];
  nextBlocks[index] = {
    ...nextBlocks[index],
    ...block,
    text: block.text ?? nextBlocks[index]?.text,
  };
  return nextBlocks;
}

function appendTextToAgentBlock(
  blocks: AgentMessageBlock[],
  blockId: string,
  delta: string,
): AgentMessageBlock[] {
  const index = blocks.findIndex((item) => item.id === blockId);
  if (index < 0) {
    return [...blocks, createTextAgentBlock(blockId, delta)];
  }

  const nextBlocks = [...blocks];
  const existing = nextBlocks[index];
  nextBlocks[index] = {
    ...existing,
    type: 'text',
    text: `${existing?.text ?? ''}${sanitizeServerPhysicalPaths(delta)}`,
  };
  return nextBlocks;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiting: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T) {
    if (this.closed) {
      return;
    }

    const resolve = this.waiting.shift();
    if (resolve) {
      resolve({ value, done: false });
      return;
    }

    this.values.push(value);
  }

  close() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    for (const resolve of this.waiting.splice(0)) {
      resolve({ value: undefined as T, done: true });
    }
  }

  async next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value) {
      return { value, done: false };
    }

    if (this.closed) {
      return { value: undefined as T, done: true };
    }

    return new Promise((resolve) => this.waiting.push(resolve));
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const nextValue = await this.next();
      if (nextValue.done) {
        return;
      }
      yield nextValue.value;
    }
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Per-conversation config persisted from createConversation */
interface ConversationConfig {
  apiKey?: string;
  baseUrl?: string;
  provider?: string;
  model?: string;
}

type QueryEngineInferenceResult =
  | {
      success: true;
      userMessageId: string;
      assistantMessageId: string;
      reply: string;
      thinking?: string;
      blocks?: AgentMessageBlock[];
      model?: string;
      usage?: Record<string, unknown>;
      durationMs?: number;
      generatedFiles?: GeneratedFile[];
      skillResults?: SkillCompletedEvent[];
      messageCreated?: boolean;
    }
  | {
      success: false;
      userMessageId?: string;
      assistantMessageId?: string;
      skillResults?: SkillCompletedEvent[];
      messageCreated?: boolean;
    };

@Injectable()
export class AgentService {
  /** Per-conversation LLM config (apiKey / baseUrl / model) */
  private conversationConfigs = new Map<string, ConversationConfig>();
  /** Per-conversation QueryEngine instances (manages own message history) */
  private queryEngines = new Map<string, QueryEngine>();
  /** Per-conversation SessionContext for ALS routing */
  private sessionContexts = new Map<string, SessionContext>();
  /** Serializes first-use restoration after a process restart. */
  private queryEngineInitializations = new Map<
    string,
    { userId: string; promise: Promise<QueryEngine> }
  >();
  private disposedConversationOwners = new Map<string, string>();

  constructor(
    @Optional() private readonly settingsService?: SettingsService,
    @Optional() private readonly profileV2Service?: ProfileV2Service,
    @Optional() private readonly profileMemoryService?: ProfileMemoryService,
    @Optional() private readonly profileProposalService?: ProfileProposalService,
    @Optional() private readonly profileRecallService?: ProfileRecallService,
    @Optional() private readonly profileProductProjectionService?: ProfileProductProjectionService,
    @Optional() private readonly profileProductMutationService?: ProfileProductMutationService,
    @Optional() private readonly profileEvidenceService?: ProfileEvidenceService,
    @Optional() private readonly githubMcpRuntimeService?: GithubMcpRuntimeService,
  ) {}

  /**
   * Run a service-owned Profile maintenance loop with no conversation,
   * transcript, Conversation Memory checkpoint, generated-file scan, or SSE.
   * The caller supplies an exact allowlist containing only profile_read and
   * profile_update; the final model reply is deliberately discarded.
   */
  async runEphemeralProfileRefresh(input: {
    userId: number;
    prompt: string;
    tools: Tool[];
    abortSignal?: AbortSignal;
  }): Promise<void> {
    if (input.tools.length !== 2
      || new Set(input.tools.map((tool) => tool.name)).size !== 2
      || !input.tools.every((tool) => tool.name === 'profile_read' || tool.name === 'profile_update')) {
      throw new Error('Profile refresh runner requires the exact Profile tool allowlist');
    }
    const saved = await this.settingsService?.getApiSettings(input.userId);
    const jobSessionId = `profile-refresh-${randomUUID()}`;
    const ctx = this.buildSessionContext(jobSessionId, String(input.userId), {
      apiKey: saved?.apiKey,
      baseUrl: saved?.baseUrl,
      provider: saved?.provider,
      model: saved?.model,
    });
    ctx.state.sessionPersistenceDisabled = true;
    ctx.config.appendSystemPrompt = input.prompt;
    ctx.config.conversationMemoryDir = undefined;
    ctx.config.conversationMemorySessionFile = undefined;
    const timeout = setTimeout(() => ctx.abortController.abort(), 600_000);
    const externalAbort = () => ctx.abortController.abort();
    input.abortSignal?.addEventListener('abort', externalAbort, { once: true });

    const previous = {
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseUrl: process.env.ANTHROPIC_BASE_URL,
      model: process.env.ANTHROPIC_MODEL,
    };
    try {
      if (saved?.apiKey) process.env.ANTHROPIC_API_KEY = saved.apiKey;
      if (saved?.baseUrl) process.env.ANTHROPIC_BASE_URL = saved.baseUrl;
      if (saved?.model) process.env.ANTHROPIC_MODEL = saved.model;
      await runWithSessionContext(ctx, async () => {
        const queryEngine = createQueryEngineForSession(ctx, {
          initialMessages: [],
          commands: [],
          exactTools: input.tools,
        });
        ctx.queryEngine = queryEngine;
        const stream = queryEngine.submitMessage(
          'Review the supplied evidence catalog and refresh the Profile now.',
          { uuid: randomUUID() },
        );
        for await (const _event of stream) {
          if (ctx.abortController.signal.aborted) break;
        }
      });
      if (ctx.abortController.signal.aborted) throw new Error('PROFILE_REFRESH_TIMEOUT');
    } finally {
      clearTimeout(timeout);
      input.abortSignal?.removeEventListener('abort', externalAbort);
      ctx.abortController.abort();
      ctx.queryEngine = null;
      this.restoreEnvironment('ANTHROPIC_API_KEY', previous.apiKey);
      this.restoreEnvironment('ANTHROPIC_BASE_URL', previous.baseUrl);
      this.restoreEnvironment('ANTHROPIC_MODEL', previous.model);
    }
  }

  private restoreEnvironment(name: string, value: string | undefined) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  async runIsolatedPrompt(input: {
    userId: string;
    content: string;
    apiKey?: string;
    baseUrl?: string;
    provider?: string;
    model?: string;
    conversationId?: string;
    abortSignal?: AbortSignal;
    onProgress?: (event: {
      type: 'reasoning.delta' | 'reply.delta';
      delta: string;
    }) => void;
  }): Promise<{
    success: boolean;
    reply?: string;
    thinking?: string;
    model?: string;
    generatedFiles?: GeneratedFile[];
  }> {
    const tempConversationId =
      input.conversationId && input.conversationId.trim().length > 0
        ? `${input.conversationId}-skill`
        : `skill-${randomUUID()}`;

    try {
      const config = {
        apiKey: input.apiKey,
        baseUrl: input.baseUrl,
        provider: input.provider,
        model: input.model,
      };
      let result;

      if (input.onProgress || input.abortSignal) {
        const eventQueue = new AsyncEventQueue<AgentStreamEvent>();
        const userMessageId = randomUUID();
        const inferencePromise = this.runStreamingInference({
          input: {
            conversationId: tempConversationId,
            userId: input.userId,
            content: input.content,
            userVisibleContent: input.content,
            abortSignal: input.abortSignal,
          },
          config,
          userMessageId,
          fallbackAssistantMessageId: `msg_assistant_skill_${randomUUID().replace(/-/g, '')}`,
          startTime: Date.now(),
          eventQueue,
        });

        for await (const event of eventQueue) {
          if (event.type === 'reasoning.delta' || event.type === 'reply.delta') {
            input.onProgress?.({ type: event.type, delta: event.delta });
          }
        }
        result = await inferencePromise;
      } else {
        result = await this.runQueryEngineInference(
          tempConversationId,
          input.userId,
          input.content,
          config,
        );
      }

      if (!result.success) return { success: false };
      return {
        success: true,
        reply: result.reply,
        thinking: result.thinking,
        model: result.model,
        generatedFiles: result.generatedFiles,
      };
    } finally {
      const context = this.sessionContexts.get(tempConversationId);
      if (context) {
        runWithSessionContext(context, () => {
          finalizeAllActiveSkillInvocations('cancelled');
        });
      }
      this.queryEngines.delete(tempConversationId);
      this.sessionContexts.delete(tempConversationId);
      this.conversationConfigs.delete(tempConversationId);
    }
  }

  async runInSessionContext<T>(input: {
    userId: string;
    conversationId?: string;
    config?: { apiKey?: string; baseUrl?: string; provider?: string; model?: string };
    callback: (context: SessionContext) => Promise<T>;
  }): Promise<T> {
    const sessionId =
      input.conversationId && input.conversationId.trim().length > 0
        ? input.conversationId
        : `skill-tool-${randomUUID()}`;
    const isTemporarySession = !input.conversationId || input.conversationId.trim().length === 0;
    const userWorkspaceDir = await ensureNetworkUserWorkspaceDir(input.userId);
    await ensureNetworkTranscriptDir(input.userId);
    this.assertCachedSessionOwner(sessionId, input.userId);

    let ctx = this.sessionContexts.get(sessionId);
    if (!ctx) {
      ctx = this.buildSessionContext(
        sessionId,
        input.userId,
        input.config ?? {},
        userWorkspaceDir,
      );
      this.sessionContexts.set(sessionId, ctx);
    } else if (input.config) {
      this.refreshCachedSessionConfig(sessionId, input.config);
    }

    if (this.settingsService) {
      const saved = await this.settingsService.getApiSettings(Number(input.userId));
      if (saved) {
        setSessionMultimodalConfig(sessionId, {
          image_url: saved.imageUrl,
          image_key: saved.imageKey,
          image_default_model: saved.imageDefaultModel,
          image_models: saved.imageModels
            ? saved.imageModels.split(',').map((s) => s.trim()).filter(Boolean)
            : undefined,
          video_url: saved.videoUrl,
          video_key: saved.videoKey,
          video_default_model: saved.videoDefaultModel,
          video_models: saved.videoModels
            ? saved.videoModels.split(',').map((s) => s.trim()).filter(Boolean)
            : undefined,
        });
      }
    }

    try {
      return await runWithSessionContext(ctx, async () => input.callback(ctx));
    } finally {
      removeSessionMultimodalConfig(sessionId);
      if (isTemporarySession) {
        runWithSessionContext(ctx, () => {
          finalizeAllActiveSkillInvocations('cancelled');
        });
        this.sessionContexts.delete(sessionId);
        this.queryEngines.delete(sessionId);
        this.conversationConfigs.delete(sessionId);
      }
    }
  }

  async createConversation(
    input: AgentCreateConversationInput,
  ): Promise<AgentConversationMetadata> {
    const meta = await createConversation(input);
    this.disposedConversationOwners.delete(meta.conversationId);
    if (input.apiKey || input.baseUrl || input.provider || input.model) {
      this.conversationConfigs.set(meta.conversationId, {
        apiKey: input.apiKey,
        baseUrl: input.baseUrl,
        provider: input.provider,
        model: input.model,
      });
    }
    return meta;
  }

  async disposeConversationRuntime(
    userId: string,
    conversationId: string,
  ): Promise<void> {
    this.assertCachedSessionOwner(conversationId, userId);
    const pending = this.queryEngineInitializations.get(conversationId);
    if (pending && pending.userId !== userId) {
      throw new Error('Session ownership mismatch');
    }

    this.disposedConversationOwners.set(conversationId, userId);
    const context = this.sessionContexts.get(conversationId);
    if (context) {
      runWithSessionContext(context, () => {
        finalizeAllActiveSkillInvocations('cancelled');
      });
    }
    try {
      context?.abortController?.abort();
    } catch {
      // Best-effort abort; map cleanup still prevents runtime reuse.
    }
    if (context) {
      for (const pendingResponse of context.pendingToolResponses.values()) {
        clearTimeout(pendingResponse.timeout);
        pendingResponse.resolve({ approved: false });
      }
      context.pendingToolResponses.clear();
      if (context.ownsMcpClients) {
        await Promise.allSettled(
          context.mcpClients.map((client) =>
            client.type === 'connected' ? client.cleanup() : Promise.resolve(),
          ),
        );
      }
      for (const connection of context.wsConnections) {
        try {
          connection.close?.();
        } catch {
          // Best-effort close for runtime-owned websocket connections.
        }
      }
      context.wsConnections.clear();
    }
    this.queryEngines.delete(conversationId);
    this.sessionContexts.delete(conversationId);
    this.conversationConfigs.delete(conversationId);
    this.queryEngineInitializations.delete(conversationId);
    removeSessionMultimodalConfig(conversationId);
  }

  restoreConversationRuntimeAfterFailedDeletion(
    userId: string,
    conversationId: string,
  ): void {
    const disposedOwner = this.disposedConversationOwners.get(conversationId);
    if (disposedOwner && disposedOwner !== userId) {
      throw new Error('Session ownership mismatch');
    }
    if (disposedOwner === userId) {
      this.disposedConversationOwners.delete(conversationId);
    }
  }

  /** Resolve an interactive tool invocation for the active conversation session. */
  async respondToInteractiveTool(
    conversationId: string,
    userId: string,
    toolUseId: string,
    payload: ToolResponsePayload,
  ): Promise<boolean> {
    this.assertCachedSessionOwner(conversationId, userId);
    const context = this.sessionContexts.get(conversationId);
    const pending = context?.pendingToolResponses.get(toolUseId);
    if (!pending) {
      return false;
    }

    pending.resolve(payload);
    return true;
  }

  async sendMessage(input: AgentSendMessageInput): Promise<AgentSendMessageResult> {
    const { conversationId, userId, content, clientRequestId } = input;
    const userVisibleContent = input.userVisibleContent ?? content;
    const userMessageId = input.userMessageId ?? randomUUID();
    const fallbackAssistantMessageId = input.assistantMessageId ?? `msg_assistant_${randomUUID().replace(/-/g, '')}`;
    const now = new Date();

    // 1. Merge config: message-level override > conversation-level config > user-level settings
    const convCfg = this.conversationConfigs.get(conversationId);
    let userSettings: ConversationConfig = {};
    if (this.settingsService) {
      const saved = await this.settingsService.getApiSettings(Number(userId));
      if (saved) {
        userSettings = {
          apiKey: saved.apiKey ?? undefined,
          baseUrl: saved.baseUrl ?? undefined,
          provider: saved.provider ?? undefined,
          model: saved.model ?? undefined,
        };
      }
    }
    const mergedConfig: ConversationConfig = {
      apiKey: input.apiKey ?? convCfg?.apiKey ?? userSettings.apiKey,
      baseUrl: input.baseUrl ?? convCfg?.baseUrl ?? userSettings.baseUrl,
      provider: input.provider ?? convCfg?.provider ?? userSettings.provider,
      model: input.model ?? convCfg?.model ?? userSettings.model,
    };

    if (!mergedConfig.apiKey?.trim()) {
      const errorReply = 'API key is required. Please save a model API key in Settings before sending messages.';
      const replyUuid = randomUUID();
      const assistantParentUuid = await this.appendManualUserMessage({
        userId,
        conversationId,
        userMessageId,
        content: userVisibleContent,
        clientRequestId,
        timestamp: now,
      });
      await appendJsonlEvent(userId, conversationId, {
        parentUuid: assistantParentUuid,
        isSidechain: false,
        type: 'assistant',
        message: {
          id: fallbackAssistantMessageId,
          type: 'message',
          role: 'assistant',
          model: mergedConfig.model ?? 'unknown',
          content: [createAssistantFinalBlock(errorReply)],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
        uuid: replyUuid,
        timestamp: new Date(now.getTime() + 100).toISOString(),
        sessionId: conversationId,
      });
      this.invalidateConversationRuntime(conversationId);
      return {
        accepted: false,
        status: 'failed',
        conversationId,
        userMessageId,
        assistantMessageId: fallbackAssistantMessageId,
        reply: errorReply,
        blocks: [createTextAgentBlock('text-0', errorReply)],
        raw: { error: 'API_KEY_REQUIRED' },
      };
    }

    // 2. Run inference via QueryEngine. QueryEngine is the CC-native
    // transcript writer; Network keeps resource/artifact mappings around it.
    const qeResult = await this.runQueryEngineInference(
      conversationId,
      userId,
      content,
      mergedConfig,
      input.attachments ?? [],
      userMessageId,
    );

    if (qeResult.success) {
      return {
        accepted: true,
        status: 'done',
        conversationId,
        userMessageId: qeResult.userMessageId,
        assistantMessageId: qeResult.assistantMessageId,
        reply: qeResult.reply,
        reasoning: qeResult.thinking,
        blocks: qeResult.blocks,
        generatedFiles: qeResult.generatedFiles,
        raw: {
          model: qeResult.model,
          usage: qeResult.usage,
          durationMs: qeResult.durationMs,
          ...(qeResult.skillResults?.length
            ? { skillResults: qeResult.skillResults }
            : {}),
        },
      };
    }

    // 3. Fallback to a local stub if QueryEngine is unavailable before a
    // complete assistant response is recorded.
    const stubReply = sanitizeServerPhysicalPaths(`Stub agent reply: ${userVisibleContent}`);
    const thinkingUuid = randomUUID();
    const replyUuid = randomUUID();
    const thinkingTimestamp = new Date(now.getTime() + 300).toISOString();
    const replyTimestamp = new Date(now.getTime() + 700).toISOString();

    const assistantParentUuid = await this.appendManualUserMessage({
      userId,
      conversationId,
      userMessageId,
      content: userVisibleContent,
      clientRequestId,
      timestamp: now,
    });

    await appendJsonlEvent(userId, conversationId, {
      parentUuid: assistantParentUuid,
      isSidechain: false,
      type: 'assistant',
      message: {
        id: fallbackAssistantMessageId,
        type: 'message',
        role: 'assistant',
        model: 'stub-agent',
        content: [createAssistantProcessBlock(`Preparing a response for: ${userVisibleContent}`)],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      uuid: thinkingUuid,
      timestamp: thinkingTimestamp,
      sessionId: conversationId,
    });

    await appendJsonlEvent(userId, conversationId, {
      parentUuid: thinkingUuid,
      isSidechain: false,
      type: 'assistant',
      message: {
        id: fallbackAssistantMessageId,
        type: 'message',
        role: 'assistant',
        model: 'stub-agent',
        content: [createAssistantFinalBlock(stubReply)],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      uuid: replyUuid,
      timestamp: replyTimestamp,
      sessionId: conversationId,
    });
    this.invalidateConversationRuntime(conversationId);

    return {
      accepted: true,
      status: 'done',
      conversationId,
      userMessageId,
      assistantMessageId: fallbackAssistantMessageId,
      reply: stubReply,
      reasoning: sanitizeServerPhysicalPaths(`Preparing a response for: ${userVisibleContent}`),
      blocks: [
        createStatusAgentBlock('status-0', `Preparing a response for: ${userVisibleContent}`),
        createTextAgentBlock('text-0', stubReply),
      ],
      raw: {
        kind: input.kind ?? 'markdown',
        attachmentCount: input.attachments?.length ?? 0,
        context: input.context ?? {},
        fallback: true,
        ...(qeResult.skillResults?.length
          ? { skillResults: qeResult.skillResults }
          : {}),
      },
    };
  }

  async *sendMessageStream(input: AgentSendMessageInput): AsyncGenerator<AgentStreamEvent> {
    const { conversationId, userId, content, clientRequestId } = input;
    const userVisibleContent = input.userVisibleContent ?? content;
    const userMessageId = input.userMessageId ?? randomUUID();
    const fallbackAssistantMessageId = input.assistantMessageId ?? `msg_assistant_${randomUUID().replace(/-/g, '')}`;
    const now = new Date();

    const convCfg = this.conversationConfigs.get(conversationId);
    let userSettings: ConversationConfig = {};
    if (this.settingsService) {
      const saved = await this.settingsService.getApiSettings(Number(userId));
      if (saved) {
        userSettings = {
          apiKey: saved.apiKey ?? undefined,
          baseUrl: saved.baseUrl ?? undefined,
          provider: saved.provider ?? undefined,
          model: saved.model ?? undefined,
        };
      }
    }
    const mergedConfig: ConversationConfig = {
      apiKey: input.apiKey ?? convCfg?.apiKey ?? userSettings.apiKey,
      baseUrl: input.baseUrl ?? convCfg?.baseUrl ?? userSettings.baseUrl,
      provider: input.provider ?? convCfg?.provider ?? userSettings.provider,
      model: input.model ?? convCfg?.model ?? userSettings.model,
    };

    if (!mergedConfig.apiKey?.trim()) {
      const errorReply = 'API key is required. Please save a model API key in Settings before sending messages.';
      const replyUuid = randomUUID();
      const assistantParentUuid = await this.appendManualUserMessage({
        userId,
        conversationId,
        userMessageId,
        content: userVisibleContent,
        clientRequestId,
        timestamp: now,
      });
      await appendJsonlEvent(userId, conversationId, {
        parentUuid: assistantParentUuid,
        isSidechain: false,
        type: 'assistant',
        message: {
          id: fallbackAssistantMessageId,
          type: 'message',
          role: 'assistant',
          model: mergedConfig.model ?? 'unknown',
          content: [createAssistantFinalBlock(errorReply)],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
        uuid: replyUuid,
        timestamp: new Date(now.getTime() + 100).toISOString(),
        sessionId: conversationId,
      });
      this.invalidateConversationRuntime(conversationId);

      yield {
        type: 'message.created',
        conversationId,
        userMessageId,
        assistantMessageId: fallbackAssistantMessageId,
        createdAt: now.toISOString(),
      };
      yield {
        type: 'message.block.delta',
        messageId: fallbackAssistantMessageId,
        blockId: 'text-0',
        blockType: 'text',
        delta: errorReply,
        block: createTextAgentBlock('text-0'),
      };
      yield {
        type: 'message.completed',
        accepted: false,
        status: 'failed',
        conversationId,
        userMessageId,
        assistantMessageId: fallbackAssistantMessageId,
        reply: errorReply,
        blocks: [createTextAgentBlock('text-0', errorReply)],
        raw: { error: 'API_KEY_REQUIRED' },
      };
      return;
    }

    const startTime = Date.now();
    const eventQueue = new AsyncEventQueue<AgentStreamEvent>();
    const inferencePromise = this.runStreamingInference({
      input,
      config: mergedConfig,
      userMessageId,
      fallbackAssistantMessageId,
      startTime,
      eventQueue,
    });

    for await (const event of eventQueue) {
      yield event;
    }

    const qeResult = await inferencePromise;
    if (qeResult.success) {
      if (!qeResult.messageCreated) {
        yield {
          type: 'message.created',
          conversationId,
          userMessageId: qeResult.userMessageId,
          assistantMessageId: qeResult.assistantMessageId,
          createdAt: now.toISOString(),
        };
      }
      yield {
        type: 'message.completed',
        accepted: true,
        status: 'done',
        conversationId,
        userMessageId: qeResult.userMessageId,
        assistantMessageId: qeResult.assistantMessageId,
        reply: qeResult.reply,
        reasoning: qeResult.thinking,
        generatedFiles: qeResult.generatedFiles,
        blocks: qeResult.blocks,
        raw: {
          model: qeResult.model,
          usage: qeResult.usage,
          durationMs: qeResult.durationMs,
          ...(qeResult.skillResults?.length
            ? { skillResults: qeResult.skillResults }
            : {}),
        },
      };
      return;
    }

    const stubReply = sanitizeServerPhysicalPaths(`Stub agent reply: ${userVisibleContent}`);
    const stubThinking = sanitizeServerPhysicalPaths(`Preparing a response for: ${userVisibleContent}`);
    const thinkingUuid = randomUUID();
    const replyUuid = randomUUID();

    if (!qeResult.messageCreated) {
      yield {
        type: 'message.created',
        conversationId,
        userMessageId,
        assistantMessageId: fallbackAssistantMessageId,
        createdAt: now.toISOString(),
      };
    }

    const assistantParentUuid = await this.appendManualUserMessage({
      userId,
      conversationId,
      userMessageId,
      content: userVisibleContent,
      clientRequestId,
      timestamp: now,
    });

    await appendJsonlEvent(userId, conversationId, {
      parentUuid: assistantParentUuid,
      isSidechain: false,
      type: 'assistant',
      message: {
        id: fallbackAssistantMessageId,
        type: 'message',
        role: 'assistant',
        model: 'stub-agent',
        content: [createAssistantProcessBlock(stubThinking)],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      uuid: thinkingUuid,
      timestamp: new Date(now.getTime() + 300).toISOString(),
      sessionId: conversationId,
    });

    await appendJsonlEvent(userId, conversationId, {
      parentUuid: thinkingUuid,
      isSidechain: false,
      type: 'assistant',
      message: {
        id: fallbackAssistantMessageId,
        type: 'message',
        role: 'assistant',
        model: 'stub-agent',
        content: [createAssistantFinalBlock(stubReply)],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      uuid: replyUuid,
      timestamp: new Date(now.getTime() + 700).toISOString(),
      sessionId: conversationId,
    });
    this.invalidateConversationRuntime(conversationId);

    const fallbackBlocks = [
      createStatusAgentBlock('status-0', stubThinking),
      createTextAgentBlock('text-0', stubReply),
    ];
    yield {
      type: 'message.block.completed',
      messageId: fallbackAssistantMessageId,
      block: fallbackBlocks[0]!,
    };
    yield {
      type: 'message.block.delta',
      messageId: fallbackAssistantMessageId,
      blockId: 'text-0',
      blockType: 'text',
      delta: stubReply,
      block: createTextAgentBlock('text-0'),
    };
    yield { type: 'reasoning.delta', messageId: fallbackAssistantMessageId, delta: stubThinking };
    yield {
      type: 'message.completed',
      accepted: true,
      status: 'done',
      conversationId,
      userMessageId,
      assistantMessageId: fallbackAssistantMessageId,
      reply: stubReply,
      reasoning: stubThinking,
      blocks: fallbackBlocks,
      raw: {
        kind: input.kind ?? 'markdown',
        attachmentCount: input.attachments?.length ?? 0,
        context: input.context ?? {},
        fallback: true,
        ...(qeResult.skillResults?.length
          ? { skillResults: qeResult.skillResults }
          : {}),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Private: real LLM inference via existing QueryEngine
  // -------------------------------------------------------------------------

  private async runStreamingInference(input: {
    input: AgentSendMessageInput;
    config: ConversationConfig;
    userMessageId: string;
    fallbackAssistantMessageId: string;
    startTime: number;
    eventQueue: AsyncEventQueue<AgentStreamEvent>;
  }): Promise<QueryEngineInferenceResult> {
    const {
      input: messageInput,
      config,
      userMessageId,
      fallbackAssistantMessageId,
      startTime,
      eventQueue,
    } = input;
    const { conversationId, userId, content } = messageInput;
    let abortHandler: (() => void) | undefined;
    let actualAssistantMessageId = fallbackAssistantMessageId;
    let messageCreated = false;
    const createdAt = new Date(startTime).toISOString();
    const pendingStreamDeltas: Array<{
      type: 'reasoning.delta' | 'reply.delta';
      delta: string;
    }> = [];
    const pendingBlockEvents: Array<Extract<AgentStreamEvent, {
      type: 'message.block.delta' | 'message.block.completed';
    }>> = [];
    const emitMessageCreated = (assistantId: string) => {
      if (messageCreated) {
        return;
      }
      actualAssistantMessageId = assistantId;
      messageCreated = true;
      eventQueue.push({
        type: 'message.created',
        conversationId,
        userMessageId,
        assistantMessageId: actualAssistantMessageId,
        createdAt,
      });
      for (const pending of pendingBlockEvents.splice(0)) {
        if (pending.type === 'message.block.delta') {
          eventQueue.push({
            ...pending,
            messageId: actualAssistantMessageId,
          });
        } else {
          eventQueue.push({
            ...pending,
            messageId: actualAssistantMessageId,
          });
        }
      }
      for (const pending of pendingStreamDeltas.splice(0)) {
        eventQueue.push({
          type: pending.type,
          messageId: actualAssistantMessageId,
          delta: pending.delta,
        });
      }
    };
    const pushStreamDelta = (
      type: 'reasoning.delta' | 'reply.delta',
      delta: string,
    ) => {
      if (messageCreated) {
        eventQueue.push({ type, messageId: actualAssistantMessageId, delta });
        return;
      }
      pendingStreamDeltas.push({ type, delta });
    };
    const pushBlockEvent = (
      event: Extract<AgentStreamEvent, {
        type: 'message.block.delta' | 'message.block.completed';
      }>,
    ) => {
      if (messageCreated) {
        eventQueue.push({ ...event, messageId: actualAssistantMessageId });
        return;
      }
      pendingBlockEvents.push(event);
    };

    try {
      const userWorkspaceDir = await ensureNetworkUserWorkspaceDir(userId);
      await ensureNetworkTranscriptDir(userId);

      if (this.settingsService) {
        const saved = await this.settingsService.getApiSettings(Number(userId));
        if (saved) {
          setSessionMultimodalConfig(conversationId, {
            image_url: saved.imageUrl,
            image_key: saved.imageKey,
            image_default_model: saved.imageDefaultModel,
            image_models: saved.imageModels
              ? saved.imageModels.split(',').map((s) => s.trim()).filter(Boolean)
              : undefined,
            video_url: saved.videoUrl,
            video_key: saved.videoKey,
            video_default_model: saved.videoDefaultModel,
            video_models: saved.videoModels
              ? saved.videoModels.split(',').map((s) => s.trim()).filter(Boolean)
              : undefined,
          });
        }
      }

      const queryEngine = await this.getOrCreateQueryEngine(
        conversationId,
        userId,
        config,
        userWorkspaceDir,
      );

      const ctx = this.sessionContexts.get(conversationId)!;
      if (messageInput.abortSignal) {
        abortHandler = () => {
          try {
            ctx.abortController?.abort();
          } catch {
            // Best-effort abort; QueryEngine implementations may differ.
          }
        };
        messageInput.abortSignal.addEventListener('abort', abortHandler, { once: true });
      }

      const prevApiKey = process.env.ANTHROPIC_API_KEY;
      const prevBaseUrl = process.env.ANTHROPIC_BASE_URL;
      const prevModel = process.env.ANTHROPIC_MODEL;
      const profileTurnPrompt = await this.getProfileTurnPrompt(userId, content);

      if (config.apiKey) {
        process.env.ANTHROPIC_API_KEY = config.apiKey;
      }
      if (config.baseUrl) {
        process.env.ANTHROPIC_BASE_URL = config.baseUrl;
      }
      if (config.model) {
        process.env.ANTHROPIC_MODEL = config.model;
      }

      const result = await (async () => {
        try {
          return await runWithSessionContext(ctx, async () => {
            const textParts: string[] = [];
            const thinkingParts: string[] = [];
            const loadedSkillNames = new Set<string>();
            let finalAssistantText: string | undefined;
            let finalResultText: string | undefined;
            let blocks: AgentMessageBlock[] = [];
            let blockIndex = 0;
            let textBlockIndex = 0;
            let model: string | undefined;
            let usage: Record<string, unknown> | undefined;
            const hiddenConversationMemoryToolUseIds = new Set<string>();
            const skillResults: SkillCompletedEvent[] = [];
            const conversationMemoryDir = ctx.config.conversationMemoryDir;
            let conversationMemoryMaintenanceActive = false;
            const emitPendingSkillResults = () => {
              for (const event of drainSkillLifecycleEvents()) {
                skillResults.push(event);
                emitMessageCreated(actualAssistantMessageId);
                eventQueue.push({
                  type: 'skill.completed',
                  messageId: actualAssistantMessageId,
                  ...event,
                });
              }
            };

            const inputWithAttachments = this.buildPromptWithAttachmentMentions(
              content,
              userId,
              conversationId,
              messageInput.attachments ?? [],
            );
            ctx.state.currentProfileSourceMessageId = userMessageId;
            const conversationMemoryTurnPrompt =
              await prepareConversationMemoryTurn(
                ctx,
                userMessageId,
                content,
              );
            const stream = queryEngine!.submitMessage(inputWithAttachments, {
              uuid: userMessageId,
              appendSystemPrompt: [
                profileTurnPrompt,
                conversationMemoryTurnPrompt,
              ].filter(Boolean).join('\n\n') || undefined,
            });

            for await (const msg of stream) {
              emitPendingSkillResults();
              if (messageInput.abortSignal?.aborted) {
                return {
                  reply: '',
                  thinking: '',
                  model,
                  usage,
                  aborted: true,
                  assistantMessageId: actualAssistantMessageId,
                  messageCreated,
                };
              }

              if (isConversationMemorySdkReminder(msg)) {
                conversationMemoryMaintenanceActive = true;
                continue;
              }

              if (
                conversationMemoryMaintenanceActive ||
                isInternalSdkMessage(msg)
              ) {
                continue;
              }

              const loadedSkillName = extractLoadedSkillNameFromSdkMessage(msg);
              if (loadedSkillName) {
                if (!loadedSkillNames.has(loadedSkillName)) {
                  loadedSkillNames.add(loadedSkillName);
                  emitMessageCreated(actualAssistantMessageId);
                  const skillLoadedBlock = createSkillLoadedBlock<AgentMessageBlock>(
                    loadedSkillName,
                  );
                  blocks = mergeAgentBlock(blocks, skillLoadedBlock);
                  pushBlockEvent({
                    type: 'message.block.completed',
                    messageId: actualAssistantMessageId,
                    block: skillLoadedBlock,
                  });
                }
                continue;
              }

              const msgMessage = (msg as any).message;
              if (msgMessage && Array.isArray(msgMessage.content)) {
                registerConversationMemoryAgentIdentifiers(
                  msgMessage.content,
                  ctx,
                );
                if (
                  isConversationMemoryMaintenanceMessage(
                    msgMessage.content,
                    conversationMemoryDir,
                    hiddenConversationMemoryToolUseIds,
                  )
                ) {
                  continue;
                }
                const currentMessageTextParts: string[] = [];
                if (typeof msgMessage.id === 'string' && msgMessage.id.trim()) {
                  emitMessageCreated(msgMessage.id);
                }
                for (const block of msgMessage.content) {
                  if (
                    shouldSuppressConversationMemoryBlock(
                      block,
                      conversationMemoryDir,
                      hiddenConversationMemoryToolUseIds,
                    )
                  ) {
                    continue;
                  }
                  const blockType = typeof block.type === 'string' ? block.type : '';
                  const skillToolName = extractSkillNameFromToolUseBlock(block);
                  if (skillToolName) {
                    if (!loadedSkillNames.has(skillToolName)) {
                      loadedSkillNames.add(skillToolName);
                      const skillLoadedBlock = createSkillLoadedBlock<AgentMessageBlock>(
                        skillToolName,
                      );
                      blocks = mergeAgentBlock(blocks, skillLoadedBlock);
                      pushBlockEvent({
                        type: 'message.block.completed',
                        messageId: actualAssistantMessageId,
                        block: skillLoadedBlock,
                      });
                    }
                    continue;
                  }
                  if (blockType === 'text' && typeof block.text === 'string' && block.text) {
                    const safeText = sanitizeConversationMemoryAgentText(
                      block.text,
                      ctx,
                    );
                    const textBlockId = `text-${textBlockIndex++}`;
                    textParts.push(safeText);
                    currentMessageTextParts.push(safeText);
                    blocks = appendTextToAgentBlock(blocks, textBlockId, safeText);
                    pushBlockEvent({
                      type: 'message.block.delta',
                      messageId: actualAssistantMessageId,
                      blockId: textBlockId,
                      blockType: 'text',
                      delta: safeText,
                      block: createTextAgentBlock(textBlockId),
                    });
                    continue;
                  }

                  const rawPublicBlock =
                    createPublicAgentBlockFromContentBlock(block, blockIndex);
                  const publicBlock = rawPublicBlock
                    ? sanitizeConversationMemoryAgentBlock(rawPublicBlock, ctx)
                    : null;
                  if (publicBlock) {
                    blockIndex += 1;
                    blocks = mergeAgentBlock(blocks, publicBlock);
                    const legacyReasoningText = publicBlock.text?.trim();
                    if (legacyReasoningText) {
                      thinkingParts.push(legacyReasoningText);
                    }
                    pushBlockEvent({
                      type: 'message.block.completed',
                      messageId: actualAssistantMessageId,
                      block: publicBlock,
                    });
                  }
                }
                if (msgMessage.model && !model) {
                  model = msgMessage.model;
                }
                if (msgMessage.usage && !usage) {
                  usage = msgMessage.usage;
                }
                if (currentMessageTextParts.length && msgMessage.stop_reason === 'end_turn') {
                  finalAssistantText = currentMessageTextParts.join('\n').trim();
                }
              } else if ((msg as any).type !== 'result') {
                const rawPublicBlock = createPublicAgentBlockFromContentBlock(
                  msg as Record<string, unknown>,
                  blockIndex,
                );
                const publicBlock = rawPublicBlock
                  ? sanitizeConversationMemoryAgentBlock(rawPublicBlock, ctx)
                  : null;
                if (publicBlock) {
                  blockIndex += 1;
                  blocks = mergeAgentBlock(blocks, publicBlock);
                  if (publicBlock.text?.trim()) {
                    thinkingParts.push(publicBlock.text);
                  }
                  pushBlockEvent({
                    type: 'message.block.completed',
                    messageId: actualAssistantMessageId,
                    block: publicBlock,
                  });
                }
              }

              if ((msg as any).type === 'result' && typeof (msg as any).result === 'string') {
                const safeResult = sanitizeConversationMemoryAgentText(
                  (msg as any).result,
                  ctx,
                );
                if (safeResult.trim()) {
                  finalResultText = safeResult.trim();
                  const alreadyStreamed = finalAssistantText === finalResultText
                    || textParts[textParts.length - 1]?.trim() === finalResultText;
                  if (!alreadyStreamed) {
                    const finalTextBlockId = `text-${textBlockIndex++}`;
                    blocks = appendTextToAgentBlock(blocks, finalTextBlockId, finalResultText);
                    emitMessageCreated(actualAssistantMessageId);
                    pushBlockEvent({
                      type: 'message.block.delta',
                      messageId: actualAssistantMessageId,
                      blockId: finalTextBlockId,
                      blockType: 'text',
                      delta: finalResultText,
                      block: createTextAgentBlock(finalTextBlockId),
                    });
                  }
                }
              }
            }
            emitPendingSkillResults();

            const reply = sanitizeConversationMemoryAgentText(
              finalResultText
              ?? finalAssistantText
              ?? textParts.join('\n').trim(),
              ctx,
            );
            const thinking = sanitizeConversationMemoryAgentText(
              thinkingParts.join('\n').trim(),
              ctx,
            );
            blocks = normalizeCanonicalMessageBlocks(blocks, {
              authoritativeText: reply,
            }) ?? [];

            if (reply || thinking) {
              emitMessageCreated(actualAssistantMessageId);
            }

            return {
              reply,
              thinking,
              blocks,
              model,
              usage,
              skillResults,
              assistantMessageId: actualAssistantMessageId,
              messageCreated,
            };
          });
        } finally {
          if (prevApiKey === undefined) {
            delete process.env.ANTHROPIC_API_KEY;
          } else {
            process.env.ANTHROPIC_API_KEY = prevApiKey;
          }
          if (prevBaseUrl === undefined) {
            delete process.env.ANTHROPIC_BASE_URL;
          } else {
            process.env.ANTHROPIC_BASE_URL = prevBaseUrl;
          }
          if (prevModel === undefined) {
            delete process.env.ANTHROPIC_MODEL;
          } else {
            process.env.ANTHROPIC_MODEL = prevModel;
          }
          removeSessionMultimodalConfig(conversationId);
          if (abortHandler && messageInput.abortSignal) {
            messageInput.abortSignal.removeEventListener('abort', abortHandler);
          }
        }
      })();

      if (!result.reply || result.aborted) {
        await flushSessionStorage();
        return {
          success: false,
          userMessageId,
          assistantMessageId: result.assistantMessageId ?? actualAssistantMessageId,
          skillResults: result.skillResults,
          messageCreated: result.messageCreated ?? messageCreated,
        };
      }

      await flushSessionStorage();
      await this.linkCurrentTurnProfileEvidence(Number(userId), conversationId, userMessageId);

      const generatedFiles = await this.scanGeneratedFiles(
        getNetworkUserWorkspaceDir(userId),
        startTime,
      );

      return {
        success: true,
        userMessageId,
        assistantMessageId: result.assistantMessageId ?? actualAssistantMessageId,
        reply: result.reply,
        thinking: result.thinking || undefined,
        blocks: result.blocks,
        model: result.model,
        usage: result.usage,
        skillResults: result.skillResults,
        durationMs: Date.now() - startTime,
        generatedFiles: generatedFiles.length ? generatedFiles : undefined,
        messageCreated: result.messageCreated ?? messageCreated,
      };
    } catch (err: any) {
      console.error('[AgentService] QueryEngine streaming inference FAILED:', err?.message ?? err);
      const context = this.sessionContexts.get(conversationId);
      const skillResults = context
        ? runWithSessionContext(context, () => drainSkillLifecycleEvents())
        : [];
      for (const event of skillResults) {
        emitMessageCreated(actualAssistantMessageId);
        eventQueue.push({
          type: 'skill.completed',
          messageId: actualAssistantMessageId,
          ...event,
        });
      }
      return {
        success: false,
        userMessageId,
        assistantMessageId: actualAssistantMessageId,
        skillResults,
        messageCreated,
      };
    } finally {
      eventQueue.close();
    }
  }

  private async runQueryEngineInference(
    conversationId: string,
    userId: string,
    content: string,
    config: ConversationConfig,
    attachments: AgentAttachmentInput[] = [],
    userMessageId: string = randomUUID(),
    fallbackAssistantMessageId: string = `msg_assistant_${randomUUID().replace(/-/g, '')}`,
  ): Promise<QueryEngineInferenceResult> {
    const startTime = Date.now();
    let assistantMessageId = fallbackAssistantMessageId;

    try {
      const userWorkspaceDir = await ensureNetworkUserWorkspaceDir(userId);
      await ensureNetworkTranscriptDir(userId);

      // Inject per-user multimodal config BEFORE engine creation so isEnabled() sees it.
      // Also refreshed on every request so updated DB settings take effect immediately.
      if (this.settingsService) {
        const saved = await this.settingsService.getApiSettings(Number(userId));
        if (saved) {
          setSessionMultimodalConfig(conversationId, {
            image_url: saved.imageUrl,
            image_key: saved.imageKey,
            image_default_model: saved.imageDefaultModel,
            image_models: saved.imageModels
              ? saved.imageModels.split(',').map((s) => s.trim()).filter(Boolean)
              : undefined,
            video_url: saved.videoUrl,
            video_key: saved.videoKey,
            video_default_model: saved.videoDefaultModel,
            video_models: saved.videoModels
              ? saved.videoModels.split(',').map((s) => s.trim()).filter(Boolean)
              : undefined,
          });
        }
      }

      // Get or create per-conversation QueryEngine + SessionContext
      const queryEngine = await this.getOrCreateQueryEngine(
        conversationId,
        userId,
        config,
        userWorkspaceDir,
      );

      const ctx = this.sessionContexts.get(conversationId)!;

      // Run inside ALS context so all module-level helpers route correctly
      const prevApiKey = process.env.ANTHROPIC_API_KEY
      const prevBaseUrl = process.env.ANTHROPIC_BASE_URL
      const prevModel = process.env.ANTHROPIC_MODEL
      const profileTurnPrompt = await this.getProfileTurnPrompt(userId, content)

      if (config.apiKey) {
        process.env.ANTHROPIC_API_KEY = config.apiKey
      }
      if (config.baseUrl) {
        process.env.ANTHROPIC_BASE_URL = config.baseUrl
      }
      if (config.model) {
        process.env.ANTHROPIC_MODEL = config.model
      }

      const result = await (async () => {
        try {
          return await runWithSessionContext(ctx, async () => {
            const textParts: string[] = [];
            const thinkingParts: string[] = [];
            let finalAssistantText: string | undefined;
            let blocks: AgentMessageBlock[] = [];
            let blockIndex = 0;
            let textBlockIndex = 0;
            let model: string | undefined;
            let usage: Record<string, unknown> | undefined;
            const hiddenConversationMemoryToolUseIds = new Set<string>();
            const conversationMemoryDir = ctx.config.conversationMemoryDir;
            let conversationMemoryMaintenanceActive = false;

            const inputWithAttachments = this.buildPromptWithAttachmentMentions(
              content,
              userId,
              conversationId,
              attachments,
            );
            ctx.state.currentProfileSourceMessageId = userMessageId;
            const conversationMemoryTurnPrompt =
              await prepareConversationMemoryTurn(
                ctx,
                userMessageId,
                content,
              );
            const stream = queryEngine!.submitMessage(inputWithAttachments, {
              uuid: userMessageId,
              appendSystemPrompt: [
                profileTurnPrompt,
                conversationMemoryTurnPrompt,
              ].filter(Boolean).join('\n\n') || undefined,
            });

            for await (const msg of stream) {
              if (isConversationMemorySdkReminder(msg)) {
                conversationMemoryMaintenanceActive = true;
                continue;
              }
              if (
                conversationMemoryMaintenanceActive ||
                isInternalSdkMessage(msg)
              ) {
                continue;
              }
              const msgMessage = (msg as any).message;
              if (msgMessage && Array.isArray(msgMessage.content)) {
                registerConversationMemoryAgentIdentifiers(
                  msgMessage.content,
                  ctx,
                );
                if (
                  isConversationMemoryMaintenanceMessage(
                    msgMessage.content,
                    conversationMemoryDir,
                    hiddenConversationMemoryToolUseIds,
                  )
                ) {
                  continue;
                }
                const currentMessageTextParts: string[] = [];
                if (typeof msgMessage.id === 'string' && msgMessage.id.trim()) {
                  assistantMessageId = msgMessage.id;
                }
                for (const block of msgMessage.content) {
                  if (
                    shouldSuppressConversationMemoryBlock(
                      block,
                      conversationMemoryDir,
                      hiddenConversationMemoryToolUseIds,
                    )
                  ) {
                    continue;
                  }
                  if (block.type === 'text' && typeof block.text === 'string') {
                    const safeText = sanitizeConversationMemoryAgentText(
                      block.text,
                      ctx,
                    );
                    const textBlockId = `text-${textBlockIndex++}`;
                    textParts.push(safeText);
                    currentMessageTextParts.push(safeText);
                    blocks = appendTextToAgentBlock(blocks, textBlockId, safeText);
                    continue;
                  }
                  const blockType = typeof block.type === 'string' ? block.type : '';
                  const rawPublicBlock =
                    createPublicAgentBlockFromContentBlock(block, blockIndex);
                  const publicBlock = rawPublicBlock
                    ? sanitizeConversationMemoryAgentBlock(rawPublicBlock, ctx)
                    : null;
                  if (publicBlock) {
                    blockIndex += 1;
                    blocks = mergeAgentBlock(blocks, publicBlock);
                    if (publicBlock.text?.trim()) {
                      thinkingParts.push(publicBlock.text);
                    }
                  }
                }
                if (msgMessage.model && !model) {
                  model = msgMessage.model;
                }
                if (msgMessage.usage && !usage) {
                  usage = msgMessage.usage;
                }
                if (currentMessageTextParts.length && msgMessage.stop_reason === 'end_turn') {
                  finalAssistantText = currentMessageTextParts.join('\n').trim();
                }
              } else if ((msg as any).type !== 'result') {
                const rawPublicBlock = createPublicAgentBlockFromContentBlock(
                  msg as Record<string, unknown>,
                  blockIndex,
                );
                const publicBlock = rawPublicBlock
                  ? sanitizeConversationMemoryAgentBlock(rawPublicBlock, ctx)
                  : null;
                if (publicBlock) {
                  blockIndex += 1;
                  blocks = mergeAgentBlock(blocks, publicBlock);
                  if (publicBlock.text?.trim()) {
                    thinkingParts.push(publicBlock.text);
                  }
                }
              }

              if ((msg as any).type === 'result' && typeof (msg as any).result === 'string' && !textParts.length) {
                const safeResult = sanitizeConversationMemoryAgentText(
                  (msg as any).result,
                  ctx,
                );
                textParts.push(safeResult);
                blocks = appendTextToAgentBlock(blocks, 'text-0', safeResult);
              }
            }

            const reply = sanitizeConversationMemoryAgentText(
              finalAssistantText
              ?? textParts[textParts.length - 1]
              ?? '',
              ctx,
            );
            const thinking = sanitizeConversationMemoryAgentText(
              thinkingParts.join('\n').trim(),
              ctx,
            );
            const skillResults = drainSkillLifecycleEvents();

            return { reply, thinking, blocks, model, usage, skillResults, assistantMessageId };
          });
        } finally {
          if (prevApiKey === undefined) {
            delete process.env.ANTHROPIC_API_KEY;
          } else {
            process.env.ANTHROPIC_API_KEY = prevApiKey;
          }
          if (prevBaseUrl === undefined) {
            delete process.env.ANTHROPIC_BASE_URL;
          } else {
            process.env.ANTHROPIC_BASE_URL = prevBaseUrl;
          }
          if (prevModel === undefined) {
            delete process.env.ANTHROPIC_MODEL;
          } else {
            process.env.ANTHROPIC_MODEL = prevModel;
          }
          removeSessionMultimodalConfig(conversationId);
        }
      })();

      if (!result.reply) {
        console.error('[AgentService] QueryEngine returned empty reply');
        await flushSessionStorage();
        return {
          success: false,
          userMessageId,
          assistantMessageId,
          skillResults: result.skillResults,
        };
      }

      await flushSessionStorage();
      await this.linkCurrentTurnProfileEvidence(Number(userId), conversationId, userMessageId);

      const generatedFiles = await this.scanGeneratedFiles(
        getNetworkUserWorkspaceDir(userId),
        startTime,
      );

      return {
        success: true,
        userMessageId,
        assistantMessageId: result.assistantMessageId ?? assistantMessageId,
        reply: result.reply,
        thinking: result.thinking || undefined,
        blocks: result.blocks,
        model: result.model,
        usage: result.usage,
        skillResults: result.skillResults,
        durationMs: Date.now() - startTime,
        generatedFiles: generatedFiles.length ? generatedFiles : undefined,
      };
    } catch (err: any) {
      console.error('[AgentService] QueryEngine inference FAILED:', err?.message ?? err);
      const context = this.sessionContexts.get(conversationId);
      const skillResults = context
        ? runWithSessionContext(context, () => drainSkillLifecycleEvents())
        : [];
      return { success: false, userMessageId, assistantMessageId, skillResults };
    }
  }

  private async scanGeneratedFiles(
    workspaceDir: string,
    sinceMs: number,
  ): Promise<GeneratedFile[]> {
    return discoverGeneratedFiles(workspaceDir, sinceMs);
  }

  private async linkCurrentTurnProfileEvidence(
    userId: number,
    conversationId: string,
    sourceMessageId: string,
  ) {
    if (!this.profileEvidenceService || !this.profileMemoryService) return;
    try {
      const [memories, units] = await Promise.all([
        this.profileMemoryService.findActiveEntities(userId),
        listProfileEvidenceCandidates(
          getNetworkConversationMemoryDir(String(userId)),
          { limit: 100, maxChars: 50_000 },
        ),
      ]);
      const currentUnits = units.filter((unit) =>
        unit.conversationId === conversationId
        && unit.sourcePrecision === 'turn'
        && unit.sourceTurnId === sourceMessageId);
      if (!currentUnits.length) return;
      const definitions = listProfileProductFieldDefinitions();
      for (const memory of memories) {
        if (memory.sourceConversationId !== conversationId
          || memory.sourceMessageId !== sourceMessageId) continue;
        const definition = definitions.find((candidate) =>
          candidate.storage === 'memory'
          && (candidate.slotKey === memory.slotKey || candidate.aliases?.includes(memory.slotKey)));
        if (!definition) continue;
        const decoded = decodeProfileProductMemoryValue(definition, memory.content);
        const values: Array<string | undefined> = isListProfileProductCodec(definition.codec)
          ? (Array.isArray(decoded) ? decoded : [])
          : [undefined];
        for (const value of values) {
          for (const unit of currentUnits) {
            await this.profileEvidenceService.attach(userId, {
              fieldKey: definition.fieldKey,
              value,
              targetType: 'memory_value',
              profileMemoryItemId: memory.id,
              profileItemVersion: memory.itemVersion,
            }, unit, { origin: 'current_turn' });
          }
        }
      }
    } catch (error) {
      console.warn('[AgentService] current-turn Profile evidence linking failed', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private buildSessionContext(
    conversationId: string,
    userId: string,
    config: ConversationConfig = {},
    workspaceDir?: string,
  ): SessionContext {
    const resolvedWorkspaceDir = resolve(
      workspaceDir ?? getNetworkUserWorkspaceDir(userId),
    );
    const autoMemoryDir = resolve(getNetworkAutoMemoryDir(userId));
    const transcriptDir = getNetworkTranscriptDir(userId);
    const conversationMemoryDir = resolve(
      getNetworkConversationMemoryDir(userId),
    );
    const conversationMemorySessionFile = resolve(
      getNetworkConversationMemorySessionPath(userId, conversationId),
    );
    return {
      sessionId: conversationId,
      userId,
      state: createIsolatedState({
        sessionId: conversationId as any,
        userId,
        cwd: resolvedWorkspaceDir,
        originalCwd: resolvedWorkspaceDir,
        projectRoot: resolvedWorkspaceDir,
        sessionProjectDir: transcriptDir,
      } as any),
      config: {
        cwd: resolvedWorkspaceDir,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        provider: config.provider,
        model: config.model,
        userId,
        workspaceRoot: resolvedWorkspaceDir,
        autoMemoryDir,
        conversationMemoryDir,
        conversationMemorySessionFile,
        userReadOnlyRoots: [
          {
            id: `user-${userId}-uploads`,
            root: resolve(getNetworkUserFilesDir(userId)),
            allowedTools: NETWORK_READ_ONLY_FILE_TOOLS,
          },
          {
            id: `user-${userId}-transcripts`,
            root: resolve(transcriptDir),
            allowedTools: ['Read'] as const,
            pathPolicy: 'direct-session-jsonl',
          },
        ],
        sharedReadOnlyRoots: getNetworkSharedReadOnlyRoots(),
        trustedSkillCatalogRoots: getNetworkTrustedSkillCatalogRoots(),
        serviceOnlyRoots: [
          {
            id: `user-${userId}-conversation-memory-daily`,
            root: resolve(conversationMemoryDir, 'daily'),
          },
          {
            id: `user-${userId}-conversation-memory-state`,
            root: resolve(conversationMemoryDir, 'state'),
          },
          {
            id: `user-${userId}-conversation-memory-index`,
            root: resolve(conversationMemoryDir, '.index'),
          },
        ],
      },
      anthropicClient: null,
      queryEngine: null,
      mcpClients: [],
      mcpRuntimeVersion: 0,
      ownsMcpClients: false,
      wsConnections: new Set(),
      abortController: new AbortController(),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      isHeadless: true,
      sessionSwitched: {
        subscribe: () => {},
        emit: () => {},
      },
      pendingToolResponses: new Map(),
      skillReadOnlyRoots: new Set(),
    } as unknown as SessionContext;
  }

  private async getOrCreateQueryEngine(
    conversationId: string,
    userId: string,
    config: ConversationConfig,
    userWorkspaceDir: string,
  ): Promise<QueryEngine> {
    this.assertConversationRuntimeActive(conversationId, userId);
    this.refreshCachedSessionConfig(conversationId, config);
    this.assertCachedSessionOwner(conversationId, userId);

    const mcpRuntime = await this.ensureGithubMcpRuntime(userId);
    const existingContext = this.sessionContexts.get(conversationId);
    if (existingContext
      && existingContext.mcpRuntimeVersion !== mcpRuntime.version) {
      this.queryEngines.delete(conversationId);
      existingContext.queryEngine = null;
    }

    const cached = this.queryEngines.get(conversationId);
    if (cached) {
      return cached;
    }

    const pending = this.queryEngineInitializations.get(conversationId);
    if (pending) {
      if (pending.userId !== userId) {
        throw new Error('Session ownership mismatch');
      }
      const queryEngine = await pending.promise;
      this.assertConversationRuntimeActive(conversationId, userId);
      this.refreshCachedSessionConfig(conversationId, config);
      return queryEngine;
    }

    let createdContext = false;
    const initialization = (async () => {
      let ctx = this.sessionContexts.get(conversationId);
      if (!ctx) {
        ctx = this.buildSessionContext(
          conversationId,
          userId,
          config,
          userWorkspaceDir,
        );
        this.sessionContexts.set(conversationId, ctx);
        createdContext = true;
      }
      ctx.mcpClients = mcpRuntime.clients;
      ctx.mcpRuntimeVersion = mcpRuntime.version;
      ctx.ownsMcpClients = false;

      try {
        const [{ messages: initialMessages }, commands] = await Promise.all([
          loadAgentSessionHistory(userId, conversationId),
          getCommands(userWorkspaceDir),
        ]);
        this.assertConversationRuntimeActive(conversationId, userId);
        const queryEngine = createQueryEngineForSession(ctx, {
          commands,
          initialMessages,
          extraTools: this.getProfileTools(userId, conversationId),
          mcpTools: mcpRuntime.tools,
        });
        ctx.queryEngine = queryEngine;
        this.queryEngines.set(conversationId, queryEngine);
        return queryEngine;
      } catch (error) {
        if (createdContext && this.sessionContexts.get(conversationId) === ctx) {
          this.sessionContexts.delete(conversationId);
        }
        throw error;
      }
    })();

    this.queryEngineInitializations.set(conversationId, {
      userId,
      promise: initialization,
    });

    try {
      return await initialization;
    } finally {
      const current = this.queryEngineInitializations.get(conversationId);
      if (current?.promise === initialization) {
        this.queryEngineInitializations.delete(conversationId);
      }
    }
  }

  private async appendManualUserMessage(input: {
    userId: string;
    conversationId: string;
    userMessageId: string;
    content: string;
    clientRequestId?: string;
    timestamp: Date;
  }): Promise<string> {
    const history = await loadAgentSessionHistory(input.userId, input.conversationId);
    const alreadyPersisted = history.messages.some(
      (message) => message.uuid === input.userMessageId,
    );
    if (alreadyPersisted) {
      return history.tailUuid ?? input.userMessageId;
    }

    await appendJsonlEvent(input.userId, input.conversationId, {
      parentUuid: history.tailUuid,
      isSidechain: false,
      promptId: input.clientRequestId ?? randomUUID(),
      type: 'user',
      message: {
        id: input.userMessageId,
        role: 'user',
        content: input.content,
      },
      uuid: input.userMessageId,
      timestamp: input.timestamp.toISOString(),
      sessionId: input.conversationId,
    });
    return input.userMessageId;
  }

  private invalidateConversationRuntime(conversationId: string): void {
    const context = this.sessionContexts.get(conversationId);
    if (context) {
      runWithSessionContext(context, () => {
        finalizeAllActiveSkillInvocations('cancelled');
      });
    }
    this.queryEngines.delete(conversationId);
    this.sessionContexts.delete(conversationId);
  }

  private getProfileTools(userId: string, conversationId: string) {
    if (!this.profileV2Service || !this.profileMemoryService || !this.profileProposalService) {
      return [];
    }
    return createProfileTools({
      userId: Number(userId),
      conversationId,
      sourceMessageId: () => this.sessionContexts.get(conversationId)
        ?.state.currentProfileSourceMessageId ?? null,
      baseService: this.profileV2Service,
      memoryService: this.profileMemoryService,
      proposalService: this.profileProposalService,
      recallService: this.profileRecallService,
      productProjectionService: this.profileProductProjectionService,
      productMutationService: this.profileProductMutationService,
    });
  }

  private async ensureGithubMcpRuntime(userId: string): Promise<GithubMcpRuntimeSnapshot> {
    if (!this.githubMcpRuntimeService) {
      return {
        status: 'not_configured',
        version: 0,
        clients: [],
        tools: [],
        githubUser: null,
        lastError: null,
        connectedAt: null,
        lastAttemptAt: null,
      };
    }
    try {
      return await this.githubMcpRuntimeService.ensureConnected(Number(userId));
    } catch (error) {
      console.warn('[AgentService] GitHub MCP connection failed; continuing without MCP tools', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.githubMcpRuntimeService.getSnapshot(Number(userId));
    }
  }

  private async getProfileTurnPrompt(userId: string, query: string) {
    if (!this.profileRecallService) return undefined;
    try {
      const context = await this.profileRecallService.buildContext(Number(userId), query);
      return context?.rendered;
    } catch (error) {
      console.warn('[AgentService] Profile recall failed; continuing without Profile context', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private assertCachedSessionOwner(sessionId: string, userId: string) {
    const context = this.sessionContexts.get(sessionId);
    if (context?.userId && context.userId !== userId) {
      throw new Error('Session ownership mismatch');
    }
  }

  private assertConversationRuntimeActive(
    conversationId: string,
    userId: string,
  ): void {
    const disposedOwner = this.disposedConversationOwners.get(conversationId);
    if (disposedOwner && disposedOwner !== userId) {
      throw new Error('Session ownership mismatch');
    }
    if (disposedOwner === userId) {
      throw new Error('Conversation runtime has been disposed');
    }
  }

  private refreshCachedSessionConfig(
    conversationId: string,
    config: ConversationConfig,
  ): void {
    const ctx = this.sessionContexts.get(conversationId);
    if (!ctx) return;

    const apiClientChanged =
      ctx.config.apiKey !== config.apiKey
      || ctx.config.baseUrl !== config.baseUrl
      || ctx.config.provider !== config.provider;
    const modelChanged = ctx.config.model !== config.model;

    ctx.config.apiKey = config.apiKey;
    ctx.config.baseUrl = config.baseUrl;
    ctx.config.provider = config.provider;
    ctx.config.model = config.model;

    if (apiClientChanged) {
      // getAnthropicClient() caches the SDK instance on the session context.
      // Clear it whenever protocol/auth/endpoint settings change so OpenAI
      // compatibility is applied to the very next request in this conversation.
      ctx.anthropicClient = null;
    }

    if (modelChanged && config.model) {
      const queryEngine = this.queryEngines.get(conversationId) as {
        setModel?: (model: string) => void;
      } | undefined;
      queryEngine?.setModel?.(config.model);
    }
  }

  private buildPromptWithAttachmentMentions(
    content: string,
    userId: string,
    conversationId: string,
    attachments: AgentAttachmentInput[],
  ): string {
    if (!attachments.length) {
      return content;
    }

    // Use native attachment ingestion chain:
    // QueryEngine.submitMessage -> processUserInput -> getAttachmentMessages.
    // Appending @paths allows the existing parser to generate structured
    // attachment messages (including PDF/pdf_reference behavior).
    const mentionLines = attachments.map((attachment) => {
      const absPath = this.resolveAttachmentAbsolutePath(
        attachment.path,
        userId,
        conversationId,
      );
      return `@${absPath}`;
    });

    return [content, '', ...mentionLines].join('\n');
  }

  private resolveAttachmentAbsolutePath(
    inputPath: string,
    userId: string,
    conversationId: string,
  ): string {
    if (inputPath.startsWith('/api/career-agent/threads/')) {
      const fileName = inputPath.split('/').pop() ?? '';
      return join(getNetworkUserFilesDir(userId), conversationId, fileName);
    }

    const marker = '/src/Network/files/';
    const normalized = inputPath.replaceAll('\\', '/');
    const markerIndex = normalized.indexOf(marker);
    if (markerIndex >= 0) {
      const relative = normalized.slice(markerIndex + '/src/Network/'.length);
      return join(networkRootDir, relative);
    }

    if (normalized.startsWith('./src/Network/files/')) {
      const relative = normalized.replace('./src/Network/', '');
      return join(networkRootDir, relative);
    }

    if (normalized.startsWith('files/')) {
      return join(networkRootDir, normalized);
    }

    return normalized;
  }
}
