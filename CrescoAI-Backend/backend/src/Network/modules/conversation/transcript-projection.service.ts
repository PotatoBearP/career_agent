import { Injectable } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import {
  buildConversationChain,
  loadTranscriptFile,
} from '../../../utils/sessionStorage.js';
import type { TranscriptMessage } from '../../../types/logs.js';
import { generatedSkillActionToolNames } from '../../../tools/generatedSkillActionTools.js';
import {
  looksLikeServerPhysicalPath,
  sanitizeServerPhysicalPaths,
  sanitizeServerPhysicalPathsInValue,
} from '../../utils/publicOutputSanitizer.js';
import type {
  ConversationMessage,
  MessageBlock,
  MessageAction,
  MessageMedia,
} from './conversation.service.js';
import {
  createSkillLoadedBlock,
  extractLoadedSkillNameFromText,
  normalizeCanonicalMessageBlocks,
  THINKING_BLOCK_TITLE,
} from './canonical-message-blocks.js';
import {
  extractAskUserQuestionResult,
  extractAskUserQuestions,
  stripAskUserQuestionResultMetadata,
} from '../agent/ask-user-question.js';
import {
  isConversationMemoryMaintenanceMessage,
  isConversationMemoryTranscriptReminder,
  isInternalTranscriptMessage,
  isPublicTranscriptUserTurn,
  shouldSuppressConversationMemoryBlock,
} from '../../memory/conversationMemoryVisibility.js';
import {
  collectConversationMemoryPrivateIdentifiers,
  sanitizeConversationMemoryPublicText,
  sanitizeConversationMemoryPublicValue,
} from '../../memory/conversationMemoryPublicPolicy.js';

type ProjectedConversationMessage = ConversationMessage & {
  uuid?: string;
  parent_uuid?: string | null;
  parentUuid?: string | null;
  session_id?: string;
  sessionId?: string;
  model?: string;
  usage?: Record<string, unknown>;
  stop_reason?: string | null;
  stopReason?: string | null;
  blocks?: MessageBlock[];
  raw?: Record<string, unknown>;
};

interface ProjectTranscriptInput {
  filePath: string;
  sessionId: string;
  mediaByMessageId?: Map<string, MessageMedia[]>;
  conversationMemoryDir?: string;
}

@Injectable()
export class ConversationTranscriptProjectionService {
  async projectTranscriptFile(
    input: ProjectTranscriptInput,
  ): Promise<ConversationMessage[]> {
    const mediaByMessageId = input.mediaByMessageId ?? new Map<string, MessageMedia[]>();
    const { messages, leafUuids } = await loadTranscriptFile(input.filePath);
    const chain = this.selectConversationChain(messages, leafUuids);
    const transcriptPrivateConversationIds =
      collectConversationMemoryPrivateIdentifiers(
        [...messages.values()],
        input.sessionId,
      );

    if (!chain.length) {
      return this.projectLegacyJsonl(
        input.filePath,
        input.sessionId,
        mediaByMessageId,
        input.conversationMemoryDir,
      );
    }

    return this.projectTranscriptMessages(
      chain,
      input.sessionId,
      mediaByMessageId,
      input.conversationMemoryDir,
      transcriptPrivateConversationIds,
    );
  }

  private selectConversationChain(
    messages: Map<any, TranscriptMessage>,
    leafUuids: Set<any>,
  ): TranscriptMessage[] {
    const chronologicalMessages = [...messages.values()]
      .filter((message) => message.type === 'user' || message.type === 'assistant')
      .sort((a, b) => this.timestampMs(a) - this.timestampMs(b));
    const leaves = [...leafUuids]
      .map((uuid) => messages.get(uuid))
      .filter((message): message is TranscriptMessage => Boolean(message))
      .sort((a, b) => this.timestampMs(a) - this.timestampMs(b));

    const latestLeaf = leaves[leaves.length - 1];
    if (latestLeaf) {
      if (!latestLeaf.parentUuid && chronologicalMessages.length > 1) {
        return chronologicalMessages;
      }
      return buildConversationChain(messages as any, latestLeaf);
    }

    return chronologicalMessages;
  }

  private projectTranscriptMessages(
    events: TranscriptMessage[],
    sessionId: string,
    mediaByMessageId: Map<string, MessageMedia[]>,
    conversationMemoryDir?: string,
    transcriptPrivateConversationIds?: ReadonlySet<string>,
  ): ConversationMessage[] {
    const order: string[] = [];
    const map = new Map<string, ProjectedConversationMessage>();
    let activeAssistantMessageId: string | null = null;
    const hiddenSkillToolUseIds = new Set<string>();
    const skillResultToolUseIds = new Set<string>();
    let pendingSkillResults: Array<Record<string, unknown>> = [];
    const hiddenConversationMemoryToolUseIds = new Set<string>();
    const privateConversationIds =
      collectConversationMemoryPrivateIdentifiers(events, sessionId);
    for (const privateConversationId of transcriptPrivateConversationIds ?? []) {
      privateConversationIds.add(privateConversationId);
    }
    let conversationMemoryMaintenanceActive = false;

    for (const event of events) {
      if (isConversationMemoryTranscriptReminder(event)) {
        conversationMemoryMaintenanceActive = true;
        continue;
      }
      if (conversationMemoryMaintenanceActive) {
        if (isPublicTranscriptUserTurn(event)) {
          conversationMemoryMaintenanceActive = false;
        } else {
          continue;
        }
      }
      const metaSkillResult = this.normalizeSkillResult(
        (event as any).toolUseResult,
      );
      if (metaSkillResult) {
        if (activeAssistantMessageId) {
          const existing = map.get(activeAssistantMessageId);
          if (existing) {
            map.set(activeAssistantMessageId, {
              ...existing,
              raw: this.mergeProjectedRaw(existing.raw, {
                skillResults: [metaSkillResult],
              }),
            });
          }
        } else {
          pendingSkillResults = this.mergeProjectedRaw(
            { skillResults: pendingSkillResults },
            { skillResults: [metaSkillResult] },
          )?.skillResults as Array<Record<string, unknown>>;
        }
      }
      if (isInternalTranscriptMessage(event)) {
        // Internal prompts are part of the model chain, not the public chat.
        // Other internal prompts do not split the active public trajectory.
        // Conversation Memory reminders are handled by the maintenance phase
        // above, where the entire internal tail is suppressed.
        continue;
      }

      if (event.type === 'assistant') {
        this.collectHiddenSkillToolUseIds(event, hiddenSkillToolUseIds);
        this.collectSkillResultToolUseIds(
          event,
          skillResultToolUseIds,
        );
        const message = (event as any).message as Record<string, unknown> | undefined;
        if (
          isConversationMemoryMaintenanceMessage(
            message?.content,
            conversationMemoryDir,
            hiddenConversationMemoryToolUseIds,
          )
        ) {
          continue;
        }
      }

      if (event.type === 'user') {
        const skillResults = this.extractSkillResultsFromUserMessage(
          event,
          skillResultToolUseIds,
        );
        if (skillResults.length && activeAssistantMessageId) {
          const existing = map.get(activeAssistantMessageId);
          if (existing) {
            map.set(activeAssistantMessageId, {
              ...existing,
              raw: this.mergeProjectedRaw(existing.raw, { skillResults }),
            });
          }
        }
        const toolResultBlocks = this.projectToolResultBlocksFromUserMessage(
          event,
          hiddenSkillToolUseIds,
          hiddenConversationMemoryToolUseIds,
          conversationMemoryDir,
        );
        if (toolResultBlocks.length && activeAssistantMessageId) {
          const existing = map.get(activeAssistantMessageId);
          if (existing) {
            map.set(activeAssistantMessageId, {
              ...existing,
              blocks: this.mergeBlocks(existing.blocks, toolResultBlocks),
            });
          }
          continue;
        }
      }

      const projected = this.projectTranscriptMessage(
        event,
        sessionId,
        hiddenConversationMemoryToolUseIds,
        conversationMemoryDir,
      );
      if (!projected) {
        continue;
      }
      if (projected.role === 'assistant') {
        const targetMessageId = activeAssistantMessageId ?? projected.id;
        const projectedWithSkillResults = pendingSkillResults.length
          ? {
              ...projected,
              raw: this.mergeProjectedRaw(projected.raw, {
                skillResults: pendingSkillResults,
              }),
            }
          : projected;
        this.upsertProjectedMessage(
          { ...projectedWithSkillResults, id: targetMessageId },
          map,
          order,
        );
        pendingSkillResults = [];
        activeAssistantMessageId = targetMessageId;
      } else {
        this.upsertProjectedMessage(projected, map, order);
        activeAssistantMessageId = null;
      }
    }

    return order
      .map((id) => this.attachMedia(map.get(id), mediaByMessageId))
      .filter((message): message is ConversationMessage => Boolean(message))
      .map((message) => this.normalizeProjectedMessage(message))
      .map((message) =>
        this.sanitizeConversationMemoryProjectedMessage(
          message,
          privateConversationIds,
        ),
      );
  }

  private sanitizeConversationMemoryProjectedMessage(
    message: ConversationMessage,
    privateConversationIds: ReadonlySet<string>,
  ): ConversationMessage {
    return {
      ...message,
      content: sanitizeConversationMemoryPublicText(
        message.content,
        privateConversationIds,
      ),
      reasoning:
        typeof message.reasoning === 'string'
          ? sanitizeConversationMemoryPublicText(
              message.reasoning,
              privateConversationIds,
            )
          : message.reasoning,
      think:
        typeof message.think === 'string'
          ? sanitizeConversationMemoryPublicText(
              message.think,
              privateConversationIds,
            )
          : message.think,
      blocks: message.blocks
        ? sanitizeConversationMemoryPublicValue(
            message.blocks,
            privateConversationIds,
          )
        : message.blocks,
      actions: message.actions
        ? sanitizeConversationMemoryPublicValue(
            message.actions,
            privateConversationIds,
          )
        : message.actions,
    };
  }

  private projectTranscriptMessage(
    event: TranscriptMessage,
    sessionId: string,
    hiddenConversationMemoryToolUseIds: Set<string>,
    conversationMemoryDir?: string,
  ): ProjectedConversationMessage | null {
    if (event.type === 'user') {
      return this.projectUserMessage(event, sessionId);
    }
    if (event.type === 'assistant') {
      return this.projectAssistantMessage(
        event,
        sessionId,
        hiddenConversationMemoryToolUseIds,
        conversationMemoryDir,
      );
    }
    return null;
  }

  private projectUserMessage(
    event: TranscriptMessage,
    sessionId: string,
  ): ProjectedConversationMessage | null {
    const message = (event as any).message as Record<string, unknown> | undefined;
    if (message?.role !== 'user') {
      return null;
    }

    const content = this.extractUserContent(message.content);
    if (!content) {
      return null;
    }

    return {
      ...this.baseMessage(event, sessionId),
      id: this.messageId(event),
      role: 'user',
      kind: 'markdown',
      content,
      client_request_id: typeof event.promptId === 'string' ? event.promptId : undefined,
      clientRequestId: typeof event.promptId === 'string' ? event.promptId : undefined,
    };
  }

  private projectAssistantMessage(
    event: TranscriptMessage,
    sessionId: string,
    hiddenConversationMemoryToolUseIds: Set<string>,
    conversationMemoryDir?: string,
  ): ProjectedConversationMessage | null {
    const message = (event as any).message as Record<string, unknown> | undefined;
    if (message?.role !== 'assistant') {
      return null;
    }

    const assistantMessageId = this.messageId(event);
    if (!assistantMessageId) {
      return null;
    }

    const rawContent = Array.isArray(message.content)
      ? message.content.filter(
          (block) =>
            !shouldSuppressConversationMemoryBlock(
              block,
              conversationMemoryDir,
              hiddenConversationMemoryToolUseIds,
            ),
        )
      : message.content;
    const topLevelReasoning = this.normalizeText(message.reasoning ?? message.think ?? message.thinking);
    const { content, blocks } = this.extractAssistantContent(rawContent);
    const messageBlocks = topLevelReasoning
      ? [this.createStatusBlock('status-top-level', topLevelReasoning), ...(blocks ?? [])]
      : blocks;

    if (!content && !messageBlocks?.length) {
      return null;
    }

    const raw = sanitizeServerPhysicalPathsInValue({
      type: event.type,
      uuid: event.uuid,
      parentUuid: event.parentUuid ?? null,
      sessionId: (event as any).sessionId ?? sessionId,
      model: message.model,
      stop_reason: message.stop_reason,
      usage: message.usage,
    }) as Record<string, unknown>;

    return {
      ...this.baseMessage(event, sessionId),
      id: assistantMessageId,
      role: 'assistant',
      kind: content ? 'markdown' : 'status',
      content: content || 'Assistant is thinking...',
      reasoning: topLevelReasoning ?? undefined,
      think: topLevelReasoning ?? undefined,
      actions: this.normalizeActions(message.actions),
      model: typeof message.model === 'string' ? message.model : undefined,
      usage: this.isRecord(message.usage) ? message.usage : undefined,
      stop_reason: typeof message.stop_reason === 'string' ? message.stop_reason : null,
      stopReason: typeof message.stop_reason === 'string' ? message.stop_reason : null,
      blocks: messageBlocks,
      raw,
    };
  }

  private baseMessage(
    event: TranscriptMessage,
    sessionId: string,
  ): Omit<ProjectedConversationMessage, 'id' | 'role' | 'kind' | 'content'> {
    const eventSessionId = typeof (event as any).sessionId === 'string'
      ? (event as any).sessionId
      : sessionId;
    const createdAt = typeof (event as any).timestamp === 'string'
      ? (event as any).timestamp
      : new Date().toISOString();

    return {
      thread_id: eventSessionId,
      threadId: eventSessionId,
      uuid: event.uuid,
      parent_uuid: event.parentUuid ?? null,
      parentUuid: event.parentUuid ?? null,
      session_id: eventSessionId,
      sessionId: eventSessionId,
      created_at: createdAt,
      createdAt: createdAt,
    };
  }

  private extractUserContent(content: unknown): string | null {
    if (typeof content === 'string') {
      return this.normalizeUserVisibleContent(content);
    }

    return null;
  }

  private normalizeUserVisibleContent(content: string): string {
    const withoutAttachmentContext = content
      .replace(/\n?<attachment_context>[\s\S]*?<\/attachment_context>/gi, '')
      .trim();
    const lines = withoutAttachmentContext.split(/\r?\n/);

    while (lines.length) {
      const lastLine = lines[lines.length - 1]?.trim() ?? '';
      if (!lastLine.startsWith('@')) {
        break;
      }
      const mentionedPath = lastLine.slice(1).trim();
      if (!looksLikeServerPhysicalPath(mentionedPath)) {
        break;
      }
      lines.pop();
    }

    return lines.join('\n').trim();
  }

  private extractAssistantContent(rawContent: unknown): {
    content: string;
    blocks?: MessageBlock[];
  } {
    if (typeof rawContent === 'string') {
      const content = sanitizeServerPhysicalPaths(rawContent).trim();
      return {
        content,
        blocks: content ? [this.createTextBlock('text-0', content)] : undefined,
      };
    }

    const contentBlocks = Array.isArray(rawContent) ? rawContent : [];
    const blocks: MessageBlock[] = [];

    contentBlocks.forEach((block, index) => {
      if (!this.isRecord(block)) {
        return;
      }

      const projected = this.projectAssistantContentBlock(block, index);
      if (projected) {
        blocks.push(projected);
      }
    });

    const content = blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .filter(Boolean)
      .join('\n')
      .trim();

    return {
      content,
      blocks: blocks.length ? blocks : undefined,
    };
  }

  private projectAssistantContentBlock(
    block: Record<string, unknown>,
    index: number,
  ): MessageBlock | null {
    const blockType = typeof block.type === 'string' ? block.type : '';

    if (blockType === 'text') {
      const text = this.normalizeText(block.text ?? block.content);
      return text ? this.createTextBlock(`text-${index}`, text) : null;
    }

    if (this.isInternalSkillAssistantBlock(block)) {
      const skillName = this.readInternalSkillName(block);
      return skillName ? createSkillLoadedBlock<MessageBlock>(skillName) : null;
    }

    if (this.isToolResultAssistantBlock(blockType, block)) {
      return this.createToolResultBlock(block, index);
    }

    if (this.isToolFacingAssistantBlock(blockType, block)) {
      const toolName = this.readToolName(block);
      const toolUseId = this.readToolUseId(block);
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

    const processText = this.extractAssistantReasoningBlock(block);
    if (processText) {
      return this.createStatusBlock(`status-${index}`, processText);
    }

    return null;
  }

  private projectToolResultBlocksFromUserMessage(
    event: TranscriptMessage,
    hiddenSkillToolUseIds: Set<string> = new Set(),
    hiddenConversationMemoryToolUseIds: Set<string> = new Set(),
    conversationMemoryDir?: string,
  ): MessageBlock[] {
    const message = (event as any).message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) {
      return [];
    }

    const blocks: MessageBlock[] = [];
    content.forEach((item, index) => {
      if (!this.isRecord(item) || !this.isToolResultContentBlock(item)) {
        return;
      }
      if (
        shouldSuppressConversationMemoryBlock(
          item,
          conversationMemoryDir,
          hiddenConversationMemoryToolUseIds,
        )
      ) {
        return;
      }
      if (this.isInternalSkillToolResultBlock(item, hiddenSkillToolUseIds)) {
        const skillName = extractLoadedSkillNameFromText(
          this.stringifyAssistantToolResultValue(item.content ?? item.result ?? item.output ?? ''),
        );
        if (skillName) blocks.push(createSkillLoadedBlock<MessageBlock>(skillName));
        return;
      }
      blocks.push(this.createToolResultBlock(item, index));
    });
    return blocks;
  }

  private createTextBlock(id: string, text: string): MessageBlock {
    return {
      id,
      type: 'text',
      text: sanitizeServerPhysicalPaths(text),
    };
  }

  private createStatusBlock(id: string, text: string): MessageBlock {
    return {
      id,
      type: 'status',
      title: THINKING_BLOCK_TITLE,
      text: sanitizeServerPhysicalPaths(text),
    };
  }

  private createToolResultBlock(
    block: Record<string, unknown>,
    index: number,
  ): MessageBlock {
    const toolName = this.readToolName(block);
    const toolUseId = this.readToolUseId(block);
    const askUserQuestionResult = extractAskUserQuestionResult(block);
    const resultText = this.redactSensitiveReasoningText(
      stripAskUserQuestionResultMetadata(this.extractAssistantToolResultText(block)),
    );

    return {
      id: toolUseId ? `tool-result-${toolUseId}` : `tool-result-${index}`,
      type: 'tool_result',
      title: toolName ? `工具返回 · ${toolName}` : '工具返回',
      name: toolName,
      toolUseId,
      text: resultText || (block.is_error === true || block.isError === true ? '工具返回错误。' : '工具已返回。'),
      isError: block.is_error === true || block.isError === true,
      ...(askUserQuestionResult ? { answers: askUserQuestionResult.answers } : {}),
    };
  }

  private readToolUseId(block: Record<string, unknown>): string | null {
    const value = block.id ?? block.tool_use_id ?? block.toolUseId;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private readToolName(block: Record<string, unknown>): string | null {
    const value = block.name ?? block.tool_name ?? block.toolName;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private collectHiddenSkillToolUseIds(
    event: TranscriptMessage,
    hiddenSkillToolUseIds: Set<string>,
  ) {
    const message = (event as any).message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) {
      return;
    }

    for (const item of content) {
      if (!this.isRecord(item) || !this.isInternalSkillAssistantBlock(item)) {
        continue;
      }
      const toolUseId = this.readToolUseId(item);
      if (toolUseId) {
        hiddenSkillToolUseIds.add(toolUseId);
      }
    }
  }

  private collectSkillResultToolUseIds(
    event: TranscriptMessage,
    skillResultToolUseIds: Set<string>,
  ) {
    const message = (event as any).message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) {
      return;
    }

    for (const item of content) {
      if (!this.isRecord(item) || !this.isSkillResultAssistantBlock(item)) {
        continue;
      }
      const toolUseId = this.readToolUseId(item);
      if (toolUseId) {
        skillResultToolUseIds.add(toolUseId);
      }
    }
  }

  private isSkillResultAssistantBlock(
    block: Record<string, unknown>,
  ): boolean {
    const toolName = this.readToolName(block)?.toLowerCase();
    return (
      toolName === 'returnskillresult' ||
      (toolName !== undefined && generatedSkillActionToolNames.has(toolName))
    );
  }

  private extractSkillResultsFromUserMessage(
    event: TranscriptMessage,
    skillResultToolUseIds: Set<string>,
  ): Array<Record<string, unknown>> {
    const message = (event as any).message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) {
      return [];
    }

    const results: Array<Record<string, unknown>> = [];
    for (const item of content) {
      if (!this.isRecord(item) || !this.isToolResultContentBlock(item)) {
        continue;
      }
      const toolUseId = this.readToolUseId(item);
      if (!toolUseId || !skillResultToolUseIds.has(toolUseId)) {
        continue;
      }
      const value = this.parseJsonRecord(
        this.stringifyAssistantToolResultValue(
          item.content ?? item.result ?? item.output ?? '',
        ),
      );
      const normalized = this.normalizeSkillResult(value);
      if (normalized) results.push(normalized);
    }
    return results;
  }

  private normalizeSkillResult(
    value: unknown,
  ): Record<string, unknown> | null {
    if (!this.isRecord(value)) return null;
    const skillCallId = value.skill_call_id;
    const skillName = value.skill_name;
    const outcome = value.outcome;
    const summary = value.summary;
    const completedAt = value.completed_at;
    const durationMs = Number(value.duration_ms);
    if (
      (value.accepted !== true && value.execution_status !== 'completed')
      || typeof skillCallId !== 'string'
      || typeof skillName !== 'string'
      || (outcome !== 'success'
        && outcome !== 'insufficient_input'
        && outcome !== 'error')
      || typeof summary !== 'string'
      || typeof completedAt !== 'string'
      || !Number.isFinite(durationMs)
    ) {
      return null;
    }
    const completedAtMs = Date.parse(completedAt);
    const normalizedDurationMs = Math.max(0, durationMs);
    const startedAt = Number.isFinite(completedAtMs)
      ? new Date(completedAtMs - normalizedDurationMs).toISOString()
      : completedAt;
    return {
      skillCallId,
      skillName,
      outcome,
      summary: sanitizeServerPhysicalPaths(summary),
      ...(value.result !== undefined
        ? { result: sanitizeServerPhysicalPathsInValue(value.result) }
        : {}),
      startedAt,
      completedAt,
      durationMs: normalizedDurationMs,
      source: 'agent',
    };
  }

  private parseJsonRecord(value: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(value);
      return this.isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private isInternalSkillAssistantBlock(block: Record<string, unknown>): boolean {
    const toolName = this.readToolName(block)?.toLowerCase();
    if (toolName === 'skill') {
      return true;
    }

    const input = block.input;
    return (
      this.isRecord(input)
      && typeof input.skill === 'string'
      && input.skill.trim().length > 0
    );
  }

  private readInternalSkillName(block: Record<string, unknown>): string | null {
    const input = block.input;
    if (this.isRecord(input) && typeof input.skill === 'string' && input.skill.trim()) {
      return input.skill.trim();
    }
    return extractLoadedSkillNameFromText(
      this.stringifyAssistantToolResultValue(block.content ?? block.text ?? ''),
    );
  }

  private isInternalSkillToolResultBlock(
    block: Record<string, unknown>,
    hiddenSkillToolUseIds: Set<string>,
  ): boolean {
    const toolUseId = this.readToolUseId(block);
    if (toolUseId && hiddenSkillToolUseIds.has(toolUseId)) {
      return true;
    }

    const toolName = this.readToolName(block)?.toLowerCase();
    if (toolName === 'skill') {
      return true;
    }

    const resultText = this.stringifyAssistantToolResultValue(block.content ?? block.result ?? block.output ?? '');
    return /Launching skill:|Base directory for this skill:/i.test(resultText);
  }

  private extractAssistantReasoningBlock(block: Record<string, unknown>): string | null {
    const phase = this.getAssistantContentPhase(block);
    if (phase === 'final') {
      return null;
    }

    if (phase !== 'process' && block.type === 'text') {
      return null;
    }

    if (this.isToolFacingAssistantBlock(block.type, block)) {
      return this.formatFilteredAssistantToolBlock(block);
    }

    const explicitReasoning = this.normalizeText(
      block.thinking ?? block.reasoning ?? block.text ?? block.content,
    );
    if (explicitReasoning) {
      return explicitReasoning;
    }

    return this.formatStructuredProcessBlock();
  }

  private extractAssistantFinalBlock(block: Record<string, unknown>): string | null {
    const phase = this.getAssistantContentPhase(block);
    if (phase === 'process') {
      return null;
    }

    if (phase !== 'final' && block.type !== 'text') {
      return null;
    }

    return this.normalizeText(block.text ?? block.content);
  }

  private getAssistantContentPhase(block: Record<string, unknown>): 'process' | 'final' | undefined {
    const phase = block.phase ?? block.contentPhase ?? block.content_phase;
    if (typeof phase !== 'string') {
      return undefined;
    }

    const normalized = phase.trim().toLowerCase();
    if (normalized === 'process' || normalized === 'reasoning' || normalized === 'thinking') {
      return 'process';
    }
    if (normalized === 'final' || normalized === 'answer' || normalized === 'reply') {
      return 'final';
    }

    return undefined;
  }

  private upsertProjectedMessage(
    message: ProjectedConversationMessage,
    messageMap: Map<string, ProjectedConversationMessage>,
    order: string[],
  ) {
    const existing = messageMap.get(message.id);
    if (!existing) {
      messageMap.set(message.id, message);
      order.push(message.id);
      return;
    }

    const reasoning = this.normalizeText(
      [existing.reasoning ?? existing.think, message.reasoning ?? message.think]
        .filter(Boolean)
        .join('\n'),
    );

    messageMap.set(message.id, {
      ...existing,
      ...message,
      content:
        message.content && message.content !== 'Assistant is thinking...'
          ? message.content
          : existing.content,
      reasoning: reasoning ?? undefined,
      think: reasoning ?? undefined,
      actions: this.mergeMessageActions(existing.actions, message.actions),
      blocks: this.mergeBlocks(existing.blocks, message.blocks),
      raw: this.mergeProjectedRaw(existing.raw, message.raw),
      created_at: existing.created_at,
      createdAt: existing.createdAt,
    });
  }

  private mergeProjectedRaw(
    existing: Record<string, unknown> | undefined,
    incoming: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (!existing && !incoming) {
      return undefined;
    }
    const merged = { ...(existing ?? {}), ...(incoming ?? {}) };
    const skillResultsByCallId = new Map<string, Record<string, unknown>>();
    for (const raw of [existing, incoming]) {
      const skillResults = raw?.skillResults;
      if (!Array.isArray(skillResults)) {
        continue;
      }
      for (const result of skillResults) {
        if (!this.isRecord(result) || typeof result.skillCallId !== 'string') {
          continue;
        }
        skillResultsByCallId.set(result.skillCallId, result);
      }
    }
    if (skillResultsByCallId.size) {
      merged.skillResults = Array.from(skillResultsByCallId.values());
    }
    return merged;
  }

  private attachMedia(
    message: ProjectedConversationMessage | undefined,
    mediaByMessageId: Map<string, MessageMedia[]>,
  ): ConversationMessage | null {
    if (!message) {
      return null;
    }
    const media = mediaByMessageId.get(message.id) ?? [];
    if (!media.length) {
      return message;
    }
    const artifactBlock: MessageBlock = {
      id: 'artifact-0',
      type: 'artifact',
      title: '生成内容',
      text: '已生成可打开的内容。',
      media,
      actions: message.actions,
    };
    return {
      ...message,
      media,
      attachments: media,
      blocks: this.mergeBlocks(message.blocks, [artifactBlock]),
    };
  }

  private async projectLegacyJsonl(
    filePath: string,
    sessionId: string,
    mediaByMessageId: Map<string, MessageMedia[]>,
    conversationMemoryDir?: string,
  ): Promise<ConversationMessage[]> {
    const raw = await readFile(filePath, 'utf8');
    const events = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as TranscriptMessage;
        } catch {
          return null;
        }
      })
      .filter((event): event is TranscriptMessage => Boolean(event));

    return this.projectTranscriptMessages(
      events,
      sessionId,
      mediaByMessageId,
      conversationMemoryDir,
    );
  }

  private messageId(event: TranscriptMessage): string {
    const message = (event as any).message as Record<string, unknown> | undefined;
    if (typeof message?.id === 'string' && message.id.trim()) {
      return message.id;
    }
    return event.uuid;
  }

  private normalizeText(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = sanitizeServerPhysicalPaths(value).trim();
    return normalized ? normalized : null;
  }

  private normalizeActions(value: unknown): MessageAction[] | undefined {
    return Array.isArray(value) && value.length
      ? (sanitizeServerPhysicalPathsInValue(value) as MessageAction[])
      : undefined;
  }

  private mergeMessageActions(
    existingActions: MessageAction[] | undefined,
    newActions: MessageAction[] | undefined,
  ): MessageAction[] | undefined {
    const merged: MessageAction[] = [];
    const seen = new Set<string>();

    for (const action of [...(existingActions ?? []), ...(newActions ?? [])]) {
      const key = action.id ?? action.artifact_id ?? action.artifactId ?? JSON.stringify(action);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(action);
    }

    return merged.length ? merged : undefined;
  }

  private mergeBlocks(existing?: MessageBlock[], incoming?: MessageBlock[]): MessageBlock[] | undefined {
    const merged = [...(existing ?? []), ...(incoming ?? [])];
    return merged.length ? merged : undefined;
  }

  private normalizeProjectedMessage(message: ConversationMessage): ConversationMessage {
    if (message.role !== 'assistant') return message;
    const authoritativeText = message.content === 'Assistant is thinking...'
      ? ''
      : message.content;
    return {
      ...message,
      blocks: normalizeCanonicalMessageBlocks(message.blocks, {
        authoritativeText,
      }) as MessageBlock[] | undefined,
    };
  }

  private timestampMs(event: TranscriptMessage): number {
    const timestamp = typeof (event as any).timestamp === 'string'
      ? Date.parse((event as any).timestamp)
      : NaN;
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  private isToolResultContentBlock(item: unknown): boolean {
    if (!this.isRecord(item)) {
      return false;
    }
    const type = typeof item.type === 'string' ? item.type : '';
    return (
      type === 'tool_result' ||
      type.endsWith('_tool_result') ||
      (typeof item.tool_use_id === 'string' && type !== 'text')
    );
  }

  private isToolFacingAssistantBlock(
    type: unknown,
    block?: Record<string, unknown>,
  ): boolean {
    const blockType = typeof type === 'string' ? type : '';
    return (
      blockType === 'tool_use' ||
      blockType === 'tool_result' ||
      blockType === 'server_tool_use' ||
      blockType === 'mcp_tool_use' ||
      blockType.endsWith('_tool_use') ||
      blockType.endsWith('_tool_result') ||
      typeof block?.tool_use_id === 'string' ||
      typeof block?.toolUseId === 'string'
    );
  }

  private formatFilteredAssistantToolBlock(block: Record<string, unknown>): string {
    const blockType = typeof block.type === 'string' ? block.type : '';
    if (this.isToolResultAssistantBlock(blockType, block)) {
      const resultText = this.redactSensitiveReasoningText(
        this.extractAssistantToolResultText(block),
      );
      return [
        '[工具返回]',
        resultText || (block.is_error === true || block.isError === true ? '工具返回错误。' : '工具已返回。'),
      ].join('\n');
    }

    return [
      '[工具调用]',
      '正在调用工具。',
    ].join('\n');
  }

  private formatStructuredProcessBlock(): string {
    return [
      '[过程事件]',
      '正在处理过程事件。',
    ].join('\n');
  }

  private isToolResultAssistantBlock(
    blockType: string,
    block: Record<string, unknown>,
  ): boolean {
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

  private extractAssistantToolResultText(block: Record<string, unknown>): string {
    const value = block.content ?? block.result ?? block.output ?? block.error ?? block;
    return this.stringifyAssistantToolResultValue(value);
  }

  private stringifyAssistantToolResultValue(value: unknown): string {
    if (typeof value === 'string') {
      return value;
    }

    if (Array.isArray(value)) {
      return value
        .map((item) => {
          if (typeof item === 'string') {
            return item;
          }
          if (!this.isRecord(item)) {
            return String(item);
          }
          if (item.type === 'text' && typeof item.text === 'string') {
            return item.text;
          }
          if (typeof item.content === 'string') {
            return item.content;
          }
          return this.stringifyAssistantToolResultValue(item);
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

  private redactSensitiveReasoningText(input: string): string {
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
    return sanitizeServerPhysicalPaths(output).trim();
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
