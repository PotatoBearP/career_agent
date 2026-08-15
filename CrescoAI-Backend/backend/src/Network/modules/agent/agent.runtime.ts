import { randomUUID } from 'node:crypto';
import {
  appendNetworkTranscriptEvent,
  ensureNetworkTranscriptFile,
} from '../../utils/networkTranscriptStorage.js';
import type {
  JsonValue,
  SkillOutcome,
} from '../../../skills/skillLifecycleTypes.js';

export interface AgentCreateConversationInput {
  userId: string;
  title?: string;
  preview?: string;
  apiKey?: string;
  baseUrl?: string;
  provider?: string;
  model?: string;
}

export interface AgentConversationMetadata {
  conversationId: string;
  title: string;
  preview: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface AgentAttachmentInput {
  assetId: string;
  path: string;
  title?: string;
  mimeType?: string;
}

export interface AgentAskQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AgentAskQuestion {
  question: string;
  header: string;
  options: AgentAskQuestionOption[];
  multiSelect: boolean;
}

export interface AgentSendMessageInput {
  conversationId: string;
  userId: string;
  content: string;
  userVisibleContent?: string;
  kind?: string;
  attachments?: AgentAttachmentInput[];
  context?: Record<string, unknown>;
  clientRequestId?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  abortSignal?: AbortSignal;
  /** Per-message override, falls back to conversation-level config */
  apiKey?: string;
  baseUrl?: string;
  provider?: string;
  model?: string;
}

export interface GeneratedFile {
  path?: string;
  url?: string;
  kind: 'image' | 'audio' | 'video' | 'html' | 'app' | 'file';
  title?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export type AgentMessageBlockType = 'text' | 'status' | 'tool_call' | 'tool_result' | 'skill' | 'artifact' | 'ask_question';

export interface AgentMessageBlock {
  id: string;
  type: AgentMessageBlockType;
  text?: string;
  title?: string;
  name?: string | null;
  status?: string | null;
  toolUseId?: string | null;
  isError?: boolean;
  questions?: AgentAskQuestion[];
  raw?: Record<string, unknown> | null;
}

export interface AgentSendMessageResult {
  accepted: boolean;
  status: 'queued' | 'processing' | 'done' | 'failed';
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  reply: string;
  reasoning?: string;
  file?: AgentAttachmentInput | AgentAttachmentInput[];
  generatedFiles?: GeneratedFile[];
  blocks?: AgentMessageBlock[];
  raw?: Record<string, unknown>;
}

export interface AgentSkillCompletedEvent {
  type: 'skill.completed';
  messageId: string;
  skillCallId: string;
  skillName: string;
  outcome: SkillOutcome;
  summary: string;
  result?: JsonValue;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  source: 'agent' | 'harness';
}

export type AgentStreamEvent =
  | {
      type: 'message.created';
      conversationId: string;
      userMessageId: string;
      assistantMessageId: string;
      createdAt: string;
    }
  | {
      type: 'reasoning.delta';
      messageId: string;
      delta: string;
    }
  | {
      type: 'reply.delta';
      messageId: string;
      delta: string;
    }
  | {
      type: 'message.block.delta';
      messageId: string;
      blockId: string;
      blockType: AgentMessageBlockType;
      delta?: string;
      block?: AgentMessageBlock;
    }
  | {
      type: 'message.block.completed';
      messageId: string;
      block: AgentMessageBlock;
    }
  | AgentSkillCompletedEvent
  | {
      type: 'message.completed';
      accepted: boolean;
      status: AgentSendMessageResult['status'];
      conversationId: string;
      userMessageId: string;
      assistantMessageId: string;
      reply: string;
      reasoning?: string;
      file?: AgentAttachmentInput | AgentAttachmentInput[];
      generatedFiles?: GeneratedFile[];
      blocks?: AgentMessageBlock[];
      raw?: Record<string, unknown>;
    }
  | {
      type: 'error';
      conversationId: string;
      userMessageId: string;
      assistantMessageId: string;
      message: string;
      code?: string;
    };

export async function createConversation(
  input: AgentCreateConversationInput,
): Promise<AgentConversationMetadata> {
  const timestamp = new Date().toISOString();
  const conversationId = randomUUID();
  const metadata: AgentConversationMetadata = {
    conversationId,
    title: input.title?.trim() || 'New Conversation',
    preview: input.preview?.trim() || '',
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await ensureRuntimeSessionFile(input.userId, conversationId);
  return metadata;
}

export { ensureRuntimeSessionFile, appendRuntimeEvent }

async function ensureRuntimeSessionFile(userId: string, conversationId: string) {
  await ensureNetworkTranscriptFile(userId, conversationId);
}

async function appendRuntimeEvent(
  userId: string,
  conversationId: string,
  payload: Record<string, unknown>,
) {
  await appendNetworkTranscriptEvent(userId, conversationId, payload);
}
