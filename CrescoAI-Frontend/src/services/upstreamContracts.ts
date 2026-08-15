import type {
  AgentAccent,
  AskQuestion,
  AskQuestionOption,
  ArtifactRecord,
  ArtifactRenderMode,
  ArtifactStatus,
  ArtifactViewMode,
  MessageAction,
  MessageBlock,
  MessageBlockType,
  MessageMedia,
  MessageMediaKind,
  MessageFileAttachment,
  MessageKind,
  DeepPartial,
  ProfileRecord,
  ProfileSuggestion,
  ThreadMessage,
  ThreadMessageStreamEvent,
  SkillOutcome,
  ThreadStatus,
  ThreadSummary,
  UploadedConversationFile,
} from '../types/entities';
import { CAREER_AGENT_API_ROUTES } from './careerAgentApiRoutes';
import { resolveUpstreamAssetUrl } from './upstreamAssetUrls';
import { findUploadedAssetPresentation } from './uploadedAssetPresentationCache';
import { normalizeMessageBlocks } from '../modules/conversation/messageBlockNormalization';

const supportedMessageMediaKinds = new Set<MessageMediaKind>(['image', 'audio', 'video', 'html', 'app']);

function isSupportedMessageMediaKind(kind: string | undefined): kind is MessageMediaKind {
  return kind !== undefined && supportedMessageMediaKinds.has(kind as MessageMediaKind);
}

export interface UpstreamThreadSummary {
  id: string | number;
  user_id?: string | number;
  userId?: string | number;
  title?: string | null;
  preview?: string | null;
  status?: ThreadStatus | null;
  updated_at?: string | number | Date;
  updatedAt?: string | number | Date;
  created_at?: string | number | Date;
  createdAt?: string | number | Date;
}

export interface UpstreamThreadMessage {
  id: string | number;
  uuid?: string | number | null;
  parent_uuid?: string | number | null;
  parentUuid?: string | number | null;
  session_id?: string | number | null;
  sessionId?: string | number | null;
  conversation_id?: string | number;
  conversationId?: string | number;
  thread_id?: string | number;
  threadId?: string | number;
  role: ThreadMessage['role'];
  kind?: MessageKind;
  content: string;
  reasoning?: string | null;
  think?: string | null;
  agent_id?: string | number | null;
  agentId?: string | number | null;
  agent_name?: string | null;
  agentName?: string | null;
  agent_accent?: AgentAccent | null;
  agentAccent?: AgentAccent | null;
  actions?: UpstreamMessageAction[] | null;
  media?: UpstreamMessageMedia[] | null;
  attachments?: UpstreamMessageMedia[] | null;
  model?: string | null;
  usage?: Record<string, unknown> | null;
  stop_reason?: string | null;
  stopReason?: string | null;
  blocks?: unknown[] | null;
  raw?: Record<string, unknown> | null;
  created_at?: string | number | Date;
  createdAt?: string | number | Date;
}

export interface UpstreamMessageAction {
  id: string;
  kind: string;
  label: string;
  artifact_id?: string;
  artifactId?: string;
  view_mode?: string | null;
  viewMode?: string | null;
}

export interface UpstreamMessageMedia {
  id?: string | number;
  kind?: string;
  type?: string;
  url?: string | null;
  download_url?: string | null;
  downloadUrl?: string | null;
  src?: string | null;
  title?: string | null;
  caption?: string | null;
  alt?: string | null;
  mime_type?: string | null;
  mimeType?: string | null;
  poster_url?: string | null;
  posterUrl?: string | null;
  artifact_id?: string | null;
  artifactId?: string | null;
  storage_path?: string | null;
  storagePath?: string | null;
  size_bytes?: number | string | null;
  sizeBytes?: number | string | null;
  stored_file_name?: string | null;
  storedFileName?: string | null;
  original_name?: string | null;
  originalName?: string | null;
  file_name?: string | null;
  fileName?: string | null;
  created_at?: string | number | Date | null;
  createdAt?: string | number | Date | null;
}

export interface UpstreamUploadedConversationFile {
  asset_id?: string | number | null;
  assetId?: string | number | null;
  id?: string | number | null;
  kind?: string | null;
  url?: string | null;
  title?: string | null;
  mime_type?: string | null;
  mimeType?: string | null;
  size_bytes?: number | string | null;
  sizeBytes?: number | string | null;
  created_at?: string | number | Date | null;
  createdAt?: string | number | Date | null;
  storage_path?: string | null;
  storagePath?: string | null;
  stored_file_name?: string | null;
  storedFileName?: string | null;
  original_name?: string | null;
  originalName?: string | null;
}

export interface UpstreamSendThreadMessageResult {
  accepted?: boolean | null;
  message_id?: string | number | null;
  messageId?: string | number | null;
  assistant_message_id?: string | number | null;
  assistantMessageId?: string | number | null;
  status?: string | null;
}

export interface UpstreamMessageStreamEvent {
  type?: string;
  sequence?: number;
  conversation_id?: string | number | null;
  conversationId?: string | number | null;
  thread_id?: string | number | null;
  threadId?: string | number | null;
  message_id?: string | number | null;
  messageId?: string | number | null;
  assistant_message_id?: string | number | null;
  assistantMessageId?: string | number | null;
  created_at?: string | number | Date | null;
  createdAt?: string | number | Date | null;
  delta?: string | null;
  block_id?: string | number | null;
  blockId?: string | number | null;
  block_type?: string | null;
  blockType?: string | null;
  block?: unknown;
  blocks?: unknown[] | null;
  reply?: string | null;
  reasoning?: string | null;
  think?: string | null;
  model?: string | null;
  usage?: Record<string, unknown> | null;
  stop_reason?: string | null;
  stopReason?: string | null;
  raw?: Record<string, unknown> | null;
  accepted?: boolean | null;
  status?: string | null;
  actions?: UpstreamMessageAction[] | null;
  media?: UpstreamMessageMedia[] | null;
  attachments?: UpstreamMessageMedia[] | null;
  message?: string | null;
  code?: string | null;
  skill_call_id?: string | null;
  skillCallId?: string | null;
  skill_name?: string | null;
  skillName?: string | null;
  outcome?: SkillOutcome | null;
  summary?: string | null;
  result?: unknown;
  started_at?: string | number | Date | null;
  startedAt?: string | number | Date | null;
  completed_at?: string | number | Date | null;
  completedAt?: string | number | Date | null;
  duration_ms?: number | null;
  durationMs?: number | null;
  source?: 'agent' | 'harness' | null;
}

export interface UpstreamProfileSuggestion {
  rowId?: number;
  row_id?: number;
  id: string;
  title: string;
  rationale: string;
  source_thread_id?: string | null;
  sourceThreadId?: string | null;
  patch: DeepPartial<ProfileRecord> | Record<string, unknown>;
}

export interface UpstreamArtifactRecord {
  id: string | number;
  uid?: string | number | null;
  type?: ArtifactRecord['type'] | string | null;
  title?: string | null;
  status?: ArtifactStatus | 'queued' | 'failed' | string | null;
  render_mode?: ArtifactRenderMode | string | null;
  renderMode?: ArtifactRenderMode | string | null;
  revision?: number | null;
  updated_at?: string | number | Date | null;
  updatedAt?: string | number | Date | null;
  created_at?: string | number | Date | null;
  createdAt?: string | number | Date | null;
  summary?: string | null;
  payloadPath?: string | null;
  payload_path?: string | null;
  payload?: {
    html?: string | null;
    url?: string | null;
    markdown?: string | null;
    cards?: unknown[] | null;
  } | null;
}

function normalizeArtifactStatus(value: UpstreamArtifactRecord['status']): ArtifactStatus {
  if (value === 'queued') {
    return 'loading';
  }

  if (value === 'failed') {
    return 'error';
  }

  if (value === 'idle' || value === 'loading' || value === 'streaming' || value === 'ready' || value === 'stale' || value === 'error') {
    return value;
  }

  return 'idle';
}

function normalizeArtifactRenderMode(value: string | null | undefined): ArtifactRenderMode {
  return value === 'cards' || value === 'markdown' || value === 'url' ? value : 'html';
}

function normalizeArtifactType(value: string | null | undefined): ArtifactRecord['type'] {
  if (
    value === 'weekly-plan'
    || value === 'profile-summary'
    || value === 'career-roadmap'
    || value === 'mock-interview'
    || value === 'coding-assessment'
    || value === 'visual-learning'
    || value === 'app-example'
  ) {
    return value;
  }

  return 'app-example';
}

function normalizeMessageKind(value: MessageKind | undefined): MessageKind {
  return value === 'status' ? 'status' : 'markdown';
}

function normalizeId(value: string | number | null | undefined, fallback = 'unknown'): string {
  const nextValue = String(value ?? '').trim();
  return nextValue || fallback;
}

function normalizeTimestamp(value: string | number | Date | null | undefined): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
  }

  const nextValue = value?.trim();
  if (!nextValue) {
    return new Date(0).toISOString();
  }

  if (/^\d+$/.test(nextValue)) {
    const date = new Date(Number(nextValue));
    return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
  }

  return nextValue;
}

function normalizeAgentAccent(value: AgentAccent | undefined | null): AgentAccent | null {
  if (value === 'amber' || value === 'blue' || value === 'slate' || value === 'teal') {
    return value;
  }

  return null;
}

function normalizeArtifactViewMode(value: string | null | undefined): ArtifactViewMode | undefined {
  if (value === 'focus' || value === 'immersive' || value === 'pane') {
    return value;
  }

  return undefined;
}

function normalizeMessageActions(actions: UpstreamMessageAction[] | null | undefined): MessageAction[] | undefined {
  const nextActions: MessageAction[] = [];

  for (const action of actions ?? []) {
    const artifactId = action.artifactId ?? action.artifact_id;

    if (!artifactId || (action.kind !== 'open-artifact' && action.kind !== 'open_artifact')) {
      continue;
    }

    const nextAction: MessageAction = {
      id: action.id,
      kind: 'open-artifact',
      label: action.label,
      artifactId,
    };

    const viewMode = normalizeArtifactViewMode(action.viewMode ?? action.view_mode);
    if (viewMode) {
      nextAction.viewMode = viewMode;
    }

    nextActions.push(nextAction);
  }

  return nextActions.length ? nextActions : undefined;
}

function normalizeMediaUrl(value: string | null | undefined): string | null {
  const nextValue = resolveUpstreamAssetUrl(value);

  if (!nextValue || nextValue.startsWith('//')) {
    return null;
  }

  if (!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(nextValue)) {
    return nextValue;
  }

  try {
    const protocol = new URL(nextValue).protocol.toLowerCase();

    if (protocol === 'http:' || protocol === 'https:') {
      return nextValue;
    }
  } catch {
    return null;
  }

  return null;
}

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  const nextValue = value?.trim();
  return nextValue || undefined;
}

function normalizeOptionalId(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const nextValue = String(value).trim();
  return nextValue || null;
}

function normalizeRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return { ...(value as Record<string, unknown>) };
}

function normalizeMessageBlockType(value: unknown): MessageBlockType | null {
  if (
    value === 'text'
    || value === 'status'
    || value === 'tool_call'
    || value === 'tool_result'
    || value === 'skill'
    || value === 'artifact'
    || value === 'ask_question'
  ) {
    return value;
  }

  if (value === 'tool-use' || value === 'tool_use' || value === 'server_tool_use' || value === 'mcp_tool_use') {
    return 'tool_call';
  }

  if (value === 'tool-result' || value === 'tool_result') {
    return 'tool_result';
  }

  if (value === 'thinking' || value === 'reasoning' || value === 'redacted_thinking') {
    return 'status';
  }

  return null;
}

function normalizeAskQuestionOption(value: unknown): AskQuestionOption | null {
  if (!isUnknownRecord(value)) {
    return null;
  }

  const label = normalizeOptionalText(value.label as string | null | undefined);
  const description = normalizeOptionalText(value.description as string | null | undefined);
  if (!label || !description) {
    return null;
  }

  const preview = normalizeOptionalText(value.preview as string | null | undefined);
  return preview ? { label, description, preview } : { label, description };
}

function normalizeAskQuestions(value: unknown): AskQuestion[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    return undefined;
  }

  const questions = value.map((item) => {
    if (!isUnknownRecord(item)) {
      return null;
    }

    const question = normalizeOptionalText(item.question as string | null | undefined);
    const header = normalizeOptionalText(item.header as string | null | undefined);
    const options = Array.isArray(item.options)
      ? item.options
        .map(normalizeAskQuestionOption)
        .filter((option): option is AskQuestionOption => Boolean(option))
      : [];
    if (!question || !header || options.length < 2 || options.length > 4) {
      return null;
    }

    return {
      question,
      header,
      options,
      multiSelect: item.multiSelect === true || item.multi_select === true,
    } satisfies AskQuestion;
  });

  return questions.every((question): question is AskQuestion => Boolean(question))
    ? questions
    : undefined;
}

function normalizeAskQuestionAnswers(value: unknown): Record<string, string> | undefined {
  const record = normalizeRecord(value);
  if (!record) return undefined;

  const answers = Object.entries(record)
    .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string')
    .slice(0, 4)
    .map(([question, answer]) => [question.trim().slice(0, 4_000), answer.trim().slice(0, 4_000)] as const)
    .filter(([question, answer]) => Boolean(question && answer));

  return answers.length ? Object.fromEntries(answers) : undefined;
}

function normalizeBlockText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim() || undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const text = value
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (!isUnknownRecord(item)) {
          return '';
        }
        if (item.type === 'text' && typeof item.text === 'string') {
          return item.text;
        }
        if (typeof item.content === 'string') {
          return item.content;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
    return text || undefined;
  }
  return undefined;
}

function normalizeMessageBlock(input: unknown, index: number): MessageBlock | null {
  if (!isUnknownRecord(input)) {
    return null;
  }

  const rawType = input.type;
  const type = normalizeMessageBlockType(rawType);
  if (!type) {
    return null;
  }

  const id = normalizeId(input.id as string | number | null | undefined, `${type}-${index}`);
  const name = normalizeOptionalText(
    typeof input.name === 'string'
      ? input.name
      : typeof input.toolName === 'string'
        ? input.toolName
        : typeof input.tool_name === 'string'
          ? input.tool_name
          : undefined,
  ) ?? null;
  const toolUseId = normalizeOptionalId(
    (input.toolUseId as string | number | null | undefined)
    ?? (input.tool_use_id as string | number | null | undefined),
  );
  const title = normalizeOptionalText(input.title as string | null | undefined)
    ?? (type === 'tool_call'
      ? name ? `工具调用 · ${name}` : '工具调用'
      : type === 'tool_result'
        ? name ? `工具返回 · ${name}` : '工具返回'
        : type === 'skill'
          ? name ? `Skill · /${name}` : 'Skill'
          : type === 'artifact'
            ? '生成内容'
             : type === 'status'
              ? '思考'
              : undefined);
  const text = normalizeBlockText(
    input.text
    ?? input.thinking
    ?? input.reasoning
    ?? input.content
    ?? input.result
    ?? input.output
    ?? input.error,
  );

  const block: MessageBlock = {
    id,
    type,
  };

  if (text) {
    block.text = text;
  }
  if (title) {
    block.title = title;
  }
  if (name) {
    block.name = name;
  }
  if (toolUseId) {
    block.toolUseId = toolUseId;
  }
  if (typeof input.status === 'string') {
    block.status = input.status;
  }
  if (input.isError === true || input.is_error === true) {
    block.isError = true;
  }
  const questions = normalizeAskQuestions(input.questions);
  if (questions) {
    block.questions = questions;
  }
  const answers = normalizeAskQuestionAnswers(input.answers);
  if (answers) {
    block.answers = answers;
  }

  const media = normalizeMessageMedia(
    Array.isArray(input.media) ? input.media as UpstreamMessageMedia[] : undefined,
  );
  const files = normalizeMessageFiles(
    Array.isArray(input.files) ? input.files as UpstreamMessageMedia[] : undefined,
    '',
  );
  const actions = normalizeMessageActions(
    Array.isArray(input.actions) ? input.actions as UpstreamMessageAction[] : undefined,
  );

  if (media) {
    block.media = media;
  }
  if (files) {
    block.files = files;
  }
  if (actions) {
    block.actions = actions;
  }

  return block;
}

function normalizeBlocks(value: unknown[] | null | undefined): MessageBlock[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const blocks = value
    .map((item, index) => normalizeMessageBlock(item, index))
    .filter((item): item is MessageBlock => Boolean(item));
  return blocks.length ? blocks : undefined;
}

function normalizeMessageMedia(media: UpstreamMessageMedia[] | null | undefined): MessageMedia[] | undefined {
  const nextMedia: MessageMedia[] = [];

  for (const item of media ?? []) {
    const kind = item.kind ?? item.type;
    const url = normalizeMediaUrl(item.downloadUrl ?? item.download_url ?? item.url ?? item.src);
    const storedFileName = firstDefinedText(
      item.storedFileName,
      item.stored_file_name,
      item.fileName,
      item.file_name,
    );
    const presentation = findUploadedAssetPresentation({
      assetId: item.id === undefined || item.id === null ? undefined : String(item.id),
      url: item.url ?? item.src,
      storagePath: item.storagePath ?? item.storage_path,
      storedFileName,
    });

    if (!isSupportedMessageMediaKind(kind) || !url) {
      continue;
    }

    const nextItem: MessageMedia = {
      id: normalizeId(item.id, `media-${nextMedia.length + 1}`),
      kind,
      url,
      title: presentation?.name ?? normalizeOptionalText(item.title),
      caption: normalizeOptionalText(item.caption),
      alt: normalizeOptionalText(item.alt),
      mimeType: normalizeOptionalText(item.mimeType ?? item.mime_type),
      posterUrl: normalizeMediaUrl(item.posterUrl ?? item.poster_url) ?? undefined,
    };
    const artifactId = normalizeOptionalText(item.artifactId ?? item.artifact_id);
    const downloadUrl = normalizeMediaUrl(item.downloadUrl ?? item.download_url) ?? undefined;
    const storagePath = normalizeMediaUrl(item.storagePath ?? item.storage_path) ?? undefined;
    const sizeBytes = normalizeSizeBytes(item.sizeBytes ?? item.size_bytes);

    if (artifactId) {
      nextItem.artifactId = artifactId;
    }
    if (downloadUrl) {
      nextItem.downloadUrl = downloadUrl;
    }
    if (storagePath) {
      nextItem.storagePath = storagePath;
    }
    if (sizeBytes !== undefined) {
      nextItem.sizeBytes = sizeBytes;
    }

    nextMedia.push(nextItem);
  }

  return nextMedia.length ? nextMedia : undefined;
}

function firstDefinedText(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const nextValue = normalizeOptionalText(value);

    if (nextValue) {
      return nextValue;
    }
  }

  return undefined;
}

function createMessageAssetKey(item: UpstreamMessageMedia) {
  const kind = item.kind ?? item.type ?? 'unknown';
  const stableId = normalizeOptionalText(item.id === undefined || item.id === null ? undefined : String(item.id));

  if (stableId) {
    return `${kind}:${stableId}`;
  }

  const address = firstDefinedText(
    item.url,
    item.src,
    item.storagePath,
    item.storage_path,
  );

  if (address) {
    return `${kind}:${address}`;
  }

  const storedFileName = firstDefinedText(
    item.storedFileName,
    item.stored_file_name,
    item.fileName,
    item.file_name,
  );

  if (storedFileName) {
    return `${kind}:${storedFileName}`;
  }

  return `${kind}:${firstDefinedText(item.originalName, item.original_name, item.title) ?? 'unknown'}`;
}

function mergeMessageMediaRecord(existing: UpstreamMessageMedia, incoming: UpstreamMessageMedia): UpstreamMessageMedia {
  return {
    ...existing,
    ...Object.fromEntries(
      Object.entries(incoming).filter(([, value]) => value !== null && value !== undefined && value !== ''),
    ),
  };
}

function mergeMessageMediaSources(input: UpstreamThreadMessage): UpstreamMessageMedia[] {
  const merged = new Map<string, UpstreamMessageMedia>();

  for (const item of [...input.media ?? [], ...input.attachments ?? []]) {
    const key = createMessageAssetKey(item);
    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, item);
      continue;
    }

    merged.set(key, mergeMessageMediaRecord(existing, item));
  }

  return [...merged.values()];
}

function normalizeSizeBytes(value: number | string | null | undefined): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === 'string') {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : undefined;
  }

  return undefined;
}

function normalizeMessageFiles(
  media: UpstreamMessageMedia[] | null | undefined,
  fallbackThreadId: string,
): MessageFileAttachment[] | undefined {
  const nextFiles: MessageFileAttachment[] = [];

  for (const item of media ?? []) {
    const kind = item.kind ?? item.type;
    const storedFileName = firstDefinedText(
      item.storedFileName,
      item.stored_file_name,
      item.fileName,
      item.file_name,
    );
    const downloadRoute = storedFileName
      ? CAREER_AGENT_API_ROUTES.threadFile(fallbackThreadId, storedFileName)
      : undefined;
    const url = normalizeMediaUrl(
      item.downloadUrl
      ?? item.download_url
      ?? item.url
      ?? item.src
      ?? downloadRoute
      ?? item.storagePath
      ?? item.storage_path,
    );
    const presentation = findUploadedAssetPresentation({
      assetId: item.id === undefined || item.id === null ? undefined : String(item.id),
      url: item.url ?? item.src ?? downloadRoute,
      storagePath: item.storagePath ?? item.storage_path,
      storedFileName,
    });

    if (kind !== 'file' || !url) {
      continue;
    }

    nextFiles.push({
      id: normalizeId(item.id, `file-${nextFiles.length + 1}`),
      name: presentation?.name ?? firstDefinedText(
        item.title,
        item.originalName,
        item.original_name,
        item.fileName,
        item.file_name,
        storedFileName,
      ) ?? `文件 ${nextFiles.length + 1}`,
      url,
      mimeType: normalizeOptionalText(item.mimeType ?? item.mime_type),
      sizeBytes: normalizeSizeBytes(item.sizeBytes ?? item.size_bytes),
    });
  }

  return nextFiles.length ? nextFiles : undefined;
}

function extractReasoningBlock(content: string): { content: string; reasoning: string | null } {
  const matches = [...content.matchAll(/<think>([\s\S]*?)<\/think>/gi)];

  if (matches.length === 0) {
    return {
      content,
      reasoning: null,
    };
  }

  const reasoning = matches
    .map((match) => match[1]?.trim())
    .filter((segment): segment is string => Boolean(segment))
    .join('\n\n');

  const nextContent = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  return {
    content: nextContent,
    reasoning: reasoning || null,
  };
}

type UnknownRecord = Record<string, unknown>;

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unwrapProfilePayload(input: unknown): UnknownRecord {
  if (!isUnknownRecord(input)) {
    return {};
  }

  return isUnknownRecord(input.profile) ? input.profile : input;
}

function readProfileValue(source: UnknownRecord, ...aliases: string[]) {
  for (const alias of aliases) {
    if (source[alias] !== undefined) {
      return source[alias];
    }
  }

  return undefined;
}

function readProfileObject(source: UnknownRecord, ...aliases: string[]): UnknownRecord {
  const value = readProfileValue(source, ...aliases);
  return isUnknownRecord(value) ? value : {};
}

function normalizeProfileText(value: unknown, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function normalizeProfileList(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean))];
}

function readProfileText(
  nested: UnknownRecord,
  root: UnknownRecord,
  aliases: string[],
  fallback = '',
) {
  return normalizeProfileText(
    readProfileValue(nested, ...aliases) ?? readProfileValue(root, ...aliases),
    fallback,
  );
}

function readProfileListFrom(
  nested: UnknownRecord,
  root: UnknownRecord,
  aliases: string[],
) {
  return normalizeProfileList(
    readProfileValue(nested, ...aliases) ?? readProfileValue(root, ...aliases),
  );
}

/** Accept the canonical camelCase API shape plus legacy snake_case and sample `{ profile }` envelopes. */
export function sanitizeProfileRecord(input: unknown): ProfileRecord {
  const source = unwrapProfilePayload(input);
  const basicInfo = readProfileObject(source, 'basicInfo', 'basic_info');
  const careerProfile = readProfileObject(source, 'careerProfile', 'career_profile');
  const intentConstraints = readProfileObject(source, 'intentConstraints', 'intent_constraints');
  const activityRecords = readProfileObject(source, 'activityRecords', 'activity_records');
  const artifacts = readProfileObject(source, 'artifacts');
  const feedbackSignals = readProfileObject(source, 'feedbackSignals', 'feedback_signals');
  const planState = readProfileObject(source, 'planState', 'plan_state');
  const chinaResumeSupplement = readProfileObject(
    source,
    'chinaResumeSupplement',
    'china_resume_supplement',
  );
  const fullName = readProfileText(
    basicInfo,
    source,
    ['fullName', 'full_name', 'displayName', 'display_name'],
  );
  const displayName = readProfileText(
    basicInfo,
    source,
    ['displayName', 'display_name', 'fullName', 'full_name'],
    fullName,
  );
  const targetIndustries = readProfileListFrom(
    intentConstraints,
    source,
    ['targetIndustries', 'target_industries'],
  );

  return {
    schemaVersion: 'career_profile_v1',
    basicInfo: {
      fullName,
      displayName,
      contactEmail: readProfileText(basicInfo, source, ['contactEmail', 'contact_email']),
      phoneOrPreferredContact: readProfileText(
        basicInfo,
        source,
        ['phoneOrPreferredContact', 'phone_or_preferred_contact', 'preferredContact', 'preferred_contact'],
      ),
      currentCity: readProfileText(
        basicInfo,
        source,
        ['currentCity', 'current_city', 'currentCityOrTimezone', 'current_city_or_timezone', 'timezone', 'locationRegion', 'location_region', 'target_city'],
      ),
      profileAssets: readProfileListFrom(basicInfo, source, ['profileAssets', 'profile_assets']),
    },
    careerProfile: {
      candidateType: readProfileText(careerProfile, source, ['candidateType', 'candidate_type']),
      currentRole: readProfileText(careerProfile, source, ['currentRole', 'current_role']),
      employmentStatus: readProfileText(careerProfile, source, ['employmentStatus', 'employment_status']),
      careerStage: readProfileText(careerProfile, source, ['careerStage', 'career_stage']),
      educationBackground: readProfileText(
        careerProfile,
        source,
        ['educationBackground', 'education_background', 'educationAndTraining', 'education_and_training', 'educationSummary', 'education_summary'],
      ),
      workExperience: readProfileText(
        careerProfile,
        source,
        ['workExperience', 'work_experience', 'workExperienceSummary', 'work_experience_summary', 'experienceSummary', 'experience_summary'],
      ),
      projectExperience: readProfileText(
        careerProfile,
        source,
        ['projectExperience', 'project_experience', 'projectOrPracticeExperienceSummary', 'project_or_practice_experience_summary'],
      ),
      skills: readProfileListFrom(careerProfile, source, ['skills', 'coreSkills', 'core_skills', 'keyStrengths', 'key_strengths']),
      interests: readProfileListFrom(careerProfile, source, ['interests', 'interestTags', 'interest_tags']),
      strengthTags: readProfileListFrom(careerProfile, source, ['strengthTags', 'strength_tags']),
      weaknessTags: readProfileListFrom(careerProfile, source, ['weaknessTags', 'weakness_tags', 'riskSignals', 'risk_signals']),
      personalityTraits: readProfileListFrom(careerProfile, source, ['personalityTraits', 'personality_traits']),
    },
    intentConstraints: {
      targetIndustry: readProfileText(intentConstraints, source, ['targetIndustry', 'target_industry'], targetIndustries[0] ?? ''),
      targetIndustries,
      targetRole: readProfileText(intentConstraints, source, ['targetRole', 'target_role']),
      targetCity: readProfileText(
        intentConstraints,
        source,
        ['targetCity', 'target_city', 'targetCityOrWorkLocation', 'target_city_or_work_location'],
      ),
      expectedSalary: readProfileText(
        intentConstraints,
        source,
        ['expectedSalary', 'expected_salary', 'compensationExpectation', 'compensation_expectation'],
      ),
      availableTime: readProfileText(
        intentConstraints,
        source,
        ['availableTime', 'available_time', 'availabilityAndTimeline', 'availability_and_timeline', 'weeklyTimeBudget', 'weekly_time_budget'],
      ),
      jobSearchStatus: readProfileText(intentConstraints, source, ['jobSearchStatus', 'job_search_status']),
      constraints: readProfileListFrom(intentConstraints, source, ['constraints']),
      workPreferences: readProfileListFrom(intentConstraints, source, ['workPreferences', 'work_preferences']),
      learningPreferences: readProfileListFrom(intentConstraints, source, ['learningPreferences', 'learning_preferences']),
      careerGoal: readProfileText(
        intentConstraints,
        source,
        ['careerGoal', 'career_goal', 'longTermGoal', 'long_term_goal', 'shortTermGoal', 'short_term_goal'],
      ),
    },
    activityRecords: {
      learningRecords: readProfileListFrom(activityRecords, source, ['learningRecords', 'learning_records']),
      projectRecords: readProfileListFrom(activityRecords, source, ['projectRecords', 'project_records']),
      applicationRecords: readProfileListFrom(activityRecords, source, ['applicationRecords', 'application_records']),
      interviewRecords: readProfileListFrom(activityRecords, source, ['interviewRecords', 'interview_records']),
      offerRecords: readProfileListFrom(activityRecords, source, ['offerRecords', 'offer_records']),
      workRecords: readProfileListFrom(activityRecords, source, ['workRecords', 'work_records']),
    },
    artifacts: {
      resumeSummary: readProfileText(artifacts, source, ['resumeSummary', 'resume_summary']),
      portfolioLinks: readProfileListFrom(artifacts, source, ['portfolioLinks', 'portfolio_links']),
      projectMaterials: readProfileListFrom(artifacts, source, ['projectMaterials', 'project_materials']),
      coverLetters: readProfileListFrom(artifacts, source, ['coverLetters', 'cover_letters']),
    },
    feedbackSignals: {
      userFeedback: readProfileListFrom(feedbackSignals, source, ['userFeedback', 'user_feedback']),
      interviewFeedback: readProfileListFrom(feedbackSignals, source, ['interviewFeedback', 'interview_feedback']),
      mentorFeedback: readProfileListFrom(feedbackSignals, source, ['mentorFeedback', 'mentor_feedback']),
      managerFeedback: readProfileListFrom(feedbackSignals, source, ['managerFeedback', 'manager_feedback']),
      systemAssessmentFeedback: readProfileListFrom(
        feedbackSignals,
        source,
        ['systemAssessmentFeedback', 'system_assessment_feedback'],
      ),
    },
    planState: {
      learningPlan: readProfileText(planState, source, ['learningPlan', 'learning_plan']),
      projectPlan: readProfileText(planState, source, ['projectPlan', 'project_plan']),
      applicationPlan: readProfileText(planState, source, ['applicationPlan', 'application_plan']),
      interviewPlan: readProfileText(planState, source, ['interviewPlan', 'interview_plan']),
      onboardingPlan: readProfileText(planState, source, ['onboardingPlan', 'onboarding_plan']),
      promotionPlan: readProfileText(planState, source, ['promotionPlan', 'promotion_plan']),
    },
    chinaResumeSupplement: {
      jobIntentionStatement: readProfileText(
        chinaResumeSupplement,
        source,
        ['jobIntentionStatement', 'job_intention_statement'],
      ),
      educationDetail: readProfileText(
        chinaResumeSupplement,
        source,
        ['educationDetail', 'education_detail', 'educationDetailForChineseResume', 'education_detail_for_chinese_resume'],
      ),
      awardsCertificatesHighlights: readProfileText(
        chinaResumeSupplement,
        source,
        ['awardsCertificatesHighlights', 'awards_certificates_highlights'],
      ),
      conditionalFields: readProfileText(
        chinaResumeSupplement,
        source,
        ['conditionalFields', 'conditional_fields', 'conditionalChinaResumeFields', 'conditional_china_resume_fields', 'workAuthorizationStatus', 'work_authorization_status', 'relocationRemotePreference', 'relocation_remote_preference'],
      ),
    },
  };
}

export function normalizeThreadSummary(input: UpstreamThreadSummary): ThreadSummary {
  const id = normalizeId(input.id, 'thread-unknown');

  return {
    id,
    title: normalizeOptionalText(input.title) ?? `会话 ${id}`,
    preview: normalizeOptionalText(input.preview) ?? '',
    updatedAt: normalizeTimestamp(input.updatedAt ?? input.updated_at ?? input.createdAt ?? input.created_at),
    status: input.status ?? 'active',
  };
}

export function normalizeThreadMessage(input: UpstreamThreadMessage, fallbackThreadId: string): ThreadMessage {
  const shouldExtractInlineReasoning = input.role === 'assistant' && !input.reasoning && !input.think;
  const extractedReasoning = shouldExtractInlineReasoning
    ? extractReasoningBlock(input.content)
    : { content: input.content, reasoning: null };
  const rawAgentId = input.agentId ?? input.agent_id;
  const normalizedAgentId = normalizeId(rawAgentId, '');
  const mergedMedia = mergeMessageMediaSources(input);
  const raw = normalizeRecord(input.raw);
  const rawModel = typeof raw?.model === 'string' ? raw.model : undefined;
  const rawUsage = normalizeRecord(raw?.usage);
  const rawStopReason = typeof raw?.stop_reason === 'string'
    ? raw.stop_reason
    : typeof raw?.stopReason === 'string'
      ? raw.stopReason
      : undefined;
  const blocks = normalizeMessageBlocks(normalizeBlocks(input.blocks), {
    authoritativeText: input.role === 'assistant'
      ? extractedReasoning.content
      : undefined,
  });

  return {
    id: normalizeId(input.id, 'message-unknown'),
    threadId: normalizeId(
      input.threadId ?? input.thread_id ?? input.conversationId ?? input.conversation_id,
      fallbackThreadId,
    ),
    role: input.role,
    kind: normalizeMessageKind(input.kind),
    content: extractedReasoning.content,
    reasoning: input.reasoning ?? input.think ?? extractedReasoning.reasoning,
    agentId: normalizedAgentId || null,
    agentName: input.agentName ?? input.agent_name ?? null,
    agentAccent: normalizeAgentAccent(input.agentAccent ?? input.agent_accent),
    actions: input.role === 'assistant' ? normalizeMessageActions(input.actions) : undefined,
    media: normalizeMessageMedia(mergedMedia),
    files: normalizeMessageFiles(mergedMedia, fallbackThreadId),
    uuid: normalizeOptionalId(input.uuid),
    parentUuid: normalizeOptionalId(input.parentUuid ?? input.parent_uuid),
    sessionId: normalizeOptionalId(input.sessionId ?? input.session_id),
    model: normalizeOptionalText(input.model ?? rawModel),
    usage: normalizeRecord(input.usage) ?? rawUsage,
    stopReason: normalizeOptionalText(input.stopReason ?? input.stop_reason ?? rawStopReason) ?? null,
    blocks,
    raw,
    createdAt: normalizeTimestamp(input.createdAt ?? input.created_at),
  };
}

export function normalizeUploadedConversationFile(input: UpstreamUploadedConversationFile): UploadedConversationFile {
  const assetId = normalizeId(input.assetId ?? input.asset_id ?? input.id, 'asset-unknown');
  const kind = input.kind === 'image' || input.kind === 'video' ? input.kind : 'file';
  const url = normalizeMediaUrl(input.url ?? input.storagePath ?? input.storage_path) ?? '';
  const title = normalizeOptionalText(input.title ?? input.originalName ?? input.original_name) ?? assetId;

  return {
    assetId,
    kind,
    url,
    title,
    mimeType: normalizeOptionalText(input.mimeType ?? input.mime_type) ?? 'application/octet-stream',
    sizeBytes: normalizeSizeBytes(input.sizeBytes ?? input.size_bytes) ?? 0,
    createdAt: normalizeTimestamp(input.createdAt ?? input.created_at),
    storagePath: normalizeMediaUrl(input.storagePath ?? input.storage_path) ?? url,
    storedFileName: normalizeOptionalText(input.storedFileName ?? input.stored_file_name) ?? '',
    originalName: normalizeOptionalText(input.originalName ?? input.original_name) ?? title,
  };
}

export function normalizeSendThreadMessageResult(input: UpstreamSendThreadMessageResult) {
  return {
    accepted: input.accepted ?? false,
    messageId: normalizeId(input.messageId ?? input.message_id, ''),
    assistantMessageId: normalizeId(input.assistantMessageId ?? input.assistant_message_id, ''),
    status: normalizeOptionalText(input.status) ?? 'done',
  };
}

export function normalizeMessageStreamEvent(
  input: UpstreamMessageStreamEvent,
  fallbackThreadId: string,
): ThreadMessageStreamEvent | null {
  const type = input.type;
  const threadId = normalizeId(
    input.threadId ?? input.thread_id ?? input.conversationId ?? input.conversation_id,
    fallbackThreadId,
  );
  const messageId = normalizeId(input.messageId ?? input.message_id, '');
  const assistantMessageId = normalizeId(input.assistantMessageId ?? input.assistant_message_id, '');

  if (type === 'message.created') {
    return {
      type,
      threadId,
      messageId,
      assistantMessageId,
      createdAt: normalizeTimestamp(input.createdAt ?? input.created_at),
    };
  }

  if (type === 'reasoning.delta' || type === 'reply.delta') {
    if (!messageId || typeof input.delta !== 'string') {
      return null;
    }

    return {
      type,
      messageId,
      delta: input.delta,
    };
  }

  if (type === 'message.block.delta') {
    const blockId = normalizeId(input.blockId ?? input.block_id, '');
    const blockType = normalizeMessageBlockType(input.blockType ?? input.block_type);
    if (!messageId || !blockId || !blockType) {
      return null;
    }

    const normalizedBlock = normalizeMessageBlock(input.block, 0);
    return {
      type,
      messageId,
      blockId,
      blockType,
      ...(typeof input.delta === 'string' ? { delta: input.delta } : {}),
      ...(normalizedBlock ? { block: normalizedBlock } : {}),
    };
  }

  if (type === 'message.block.completed') {
    const normalizedBlock = normalizeMessageBlock(input.block, 0);
    if (!messageId || !normalizedBlock) {
      return null;
    }

    return {
      type,
      messageId,
      block: normalizedBlock,
    };
  }

  if (type === 'skill.completed') {
    const skillCallId = normalizeId(input.skillCallId ?? input.skill_call_id, '');
    const skillName = normalizeId(input.skillName ?? input.skill_name, '');
    const outcome = input.outcome;
    const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
    if (
      !messageId
      || !skillCallId
      || !skillName
      || !summary
      || (outcome !== 'success' && outcome !== 'insufficient_input' && outcome !== 'error')
    ) {
      return null;
    }
    return {
      type: 'skill.completed',
      messageId,
      skillCallId,
      skillName,
      outcome,
      summary,
      ...(input.result !== undefined ? { result: input.result } : {}),
      startedAt: normalizeTimestamp(input.startedAt ?? input.started_at),
      completedAt: normalizeTimestamp(input.completedAt ?? input.completed_at),
      durationMs: Math.max(0, Number(input.durationMs ?? input.duration_ms ?? 0)),
      source: input.source === 'harness' ? 'harness' : 'agent',
    };
  }

  if (type === 'artifact.created') {
    const mergedMedia = mergeMessageMediaSources({
      id: messageId || 'stream-artifact',
      threadId,
      role: 'assistant',
      content: '',
      media: input.media,
      attachments: input.attachments,
    });

    return {
      type,
      messageId,
      actions: normalizeMessageActions(input.actions),
      media: normalizeMessageMedia(mergedMedia),
      files: normalizeMessageFiles(mergedMedia, threadId),
    };
  }

  if (type === 'message.completed') {
    const mergedMedia = mergeMessageMediaSources({
      id: assistantMessageId || messageId || 'stream-completed',
      threadId,
      role: 'assistant',
      content: input.reply ?? '',
      media: input.media,
      attachments: input.attachments,
    });
    const raw = normalizeRecord(input.raw);
    const rawModel = typeof raw?.model === 'string' ? raw.model : undefined;
    const rawUsage = normalizeRecord(raw?.usage);
    const rawStopReason = typeof raw?.stop_reason === 'string'
      ? raw.stop_reason
      : typeof raw?.stopReason === 'string'
        ? raw.stopReason
        : undefined;
    const reasoning = normalizeOptionalText(input.reasoning ?? input.think ?? undefined);
    const model = normalizeOptionalText(input.model ?? rawModel);
    const stopReason = normalizeOptionalText(input.stopReason ?? input.stop_reason ?? rawStopReason);
    const usage = normalizeRecord(input.usage) ?? rawUsage;
    const blocks = normalizeBlocks(input.blocks);

    return {
      type,
      accepted: input.accepted ?? true,
      status: normalizeOptionalText(input.status) ?? 'done',
      threadId,
      messageId,
      assistantMessageId,
      reply: input.reply ?? '',
      ...(reasoning ? { reasoning } : {}),
      actions: normalizeMessageActions(input.actions),
      media: normalizeMessageMedia(mergedMedia),
      files: normalizeMessageFiles(mergedMedia, threadId),
      ...(blocks ? { blocks } : {}),
      ...(model ? { model } : {}),
      ...(usage ? { usage } : {}),
      ...(stopReason ? { stopReason } : {}),
      ...(raw ? { raw } : {}),
    };
  }

  if (type === 'error') {
    return {
      type,
      message: input.message ?? 'Message stream failed.',
      code: normalizeOptionalText(input.code),
    };
  }

  return null;
}

export function normalizeProfileSuggestion(input: UpstreamProfileSuggestion): ProfileSuggestion {
  const patch = sanitizeProfileRecord(input.patch);
  const rowId = input.rowId ?? input.row_id;

  return {
    ...(Number.isInteger(rowId) && Number(rowId) > 0
      ? { rowId: Number(rowId) }
      : {}),
    id: input.id,
    title: input.title,
    rationale: input.rationale,
    sourceThreadId: input.sourceThreadId ?? input.source_thread_id ?? null,
    patch: pruneEmptyProfilePatch(patch),
  };
}

function pruneEmptyProfilePatch(profile: ProfileRecord): DeepPartial<ProfileRecord> {
  const patch: DeepPartial<ProfileRecord> = {};

  for (const [sectionKey, sectionValue] of Object.entries(profile) as Array<[keyof ProfileRecord, unknown]>) {
    if (sectionKey === 'schemaVersion' || typeof sectionValue !== 'object' || sectionValue === null || Array.isArray(sectionValue)) {
      continue;
    }

    const sectionPatch: Record<string, unknown> = {};
    for (const [fieldKey, fieldValue] of Object.entries(sectionValue)) {
      if (Array.isArray(fieldValue)) {
        if (fieldValue.length > 0) {
          sectionPatch[fieldKey] = [...fieldValue];
        }
      } else if (typeof fieldValue === 'string' && fieldValue.trim()) {
        sectionPatch[fieldKey] = fieldValue;
      }
    }

    if (Object.keys(sectionPatch).length > 0) {
      patch[sectionKey] = sectionPatch as never;
    }
  }

  return patch;
}

export function normalizeArtifactRecord(input: UpstreamArtifactRecord): ArtifactRecord {
  const payloadPath = normalizeOptionalText(input.payloadPath ?? input.payload_path);
  const renderMode = payloadPath
    ? normalizeArtifactRenderMode(input.renderMode ?? input.render_mode ?? 'url')
    : normalizeArtifactRenderMode(input.renderMode ?? input.render_mode);
  const id = normalizeId(input.id, 'artifact-unknown');
  const baseRecord = {
    id,
    type: normalizeArtifactType(input.type),
    title: normalizeOptionalText(input.title) ?? `工件 ${id}`,
    status: normalizeArtifactStatus(input.status),
    revision: input.revision ?? 1,
    updatedAt: normalizeTimestamp(input.updatedAt ?? input.updated_at ?? input.createdAt ?? input.created_at),
    summary: normalizeOptionalText(input.summary) ?? '',
  };

  if (renderMode === 'url') {
    const rawUrl = input.payload?.url?.trim() ?? payloadPath ?? '';
    const resolvedUrl = resolveUpstreamAssetUrl(rawUrl) ?? rawUrl;
    return {
      ...baseRecord,
      renderMode,
      payload: {
        url: resolvedUrl,
      },
    };
  }

  if (renderMode === 'markdown') {
    return {
      ...baseRecord,
      renderMode,
      payload: {
        markdown: input.payload?.markdown?.trim() ?? '',
      },
    };
  }

  if (renderMode === 'cards') {
    return {
      ...baseRecord,
      renderMode,
      payload: {
        cards: Array.isArray(input.payload?.cards) ? [...input.payload.cards] : [],
      },
    };
  }

  return {
    ...baseRecord,
    renderMode,
    payload: {
      html: input.payload?.html ?? '',
    },
  };
}
