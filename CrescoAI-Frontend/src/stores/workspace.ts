import { defineStore } from 'pinia';
import { matchesMobileLayoutViewport } from '../app/responsive';
import { runtimeConfig } from '../config/runtime';
import { createCareerAgentClient } from '../services/createCareerAgentClient';
import { MessageStreamUnavailableError } from '../services/careerAgentClient';
import {
  createSkillLoadedBlock,
  extractSkillName,
  extractSkillNameFromBlock,
  isInternalSkillBlock,
  normalizeMessageBlocks,
  THINKING_BLOCK_TITLE,
} from '../modules/conversation/messageBlockNormalization';
import { shouldSimulateArtifactRefreshLifecycle } from './artifactRefreshPolicy';
import type {
  ArtifactRecord,
  ArtifactStatus,
  ArtifactViewMode,
  AskQuestionResponse,
  DraftMessageSubmission,
  LoadState,
  MessageAction,
  MessageBlock,
  MessageBlockType,
  MessageFileAttachment,
  MessageMedia,
  ProfileRecord,
  ProfileSuggestion,
  SkillResult,
  ThreadMessageStreamEvent,
  ThreadMessage,
  ThreadSummary,
  UploadedConversationFile,
} from '../types/entities';

const client = createCareerAgentClient();
const simulateArtifactRefreshLifecycle = shouldSimulateArtifactRefreshLifecycle(runtimeConfig);
let initializePromise: Promise<void> | null = null;
let threadLoadRequestToken = 0;
let artifactRefreshRequestToken = 0;
const INTERACTIVE_TOOL_HISTORY_POLL_INTERVAL_MS = 750;
const INTERACTIVE_TOOL_HISTORY_POLL_ATTEMPTS = 120;
const INTERACTIVE_TOOL_STREAM_SETTLE_INTERVAL_MS = 100;

function createMessageId(prefix: string) {
  const randomValue = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return `${prefix}-${randomValue}`;
}

function formatLocalTimestamp(date: Date) {
  return date.toISOString();
}

function revokeBlobUrl(value: string | null | undefined) {
  if (value?.startsWith('blob:')) {
    URL.revokeObjectURL(value);
  }
}

function revokeLocalMessageResources(messages: ThreadMessage[]) {
  for (const message of messages) {
    for (const media of message.media ?? []) {
      revokeBlobUrl(media.url);
      revokeBlobUrl(media.posterUrl);
    }

    for (const file of message.files ?? []) {
      revokeBlobUrl(file.url);
    }
  }
}

function revokeUnpreservedMessageResources(
  messages: ThreadMessage[],
  preservedMessagesByThread: Record<string, ThreadMessage[]>,
) {
  const preservedMessageIds = new Set(
    Object.values(preservedMessagesByThread)
      .flat()
      .map((message) => message.id),
  );

  revokeLocalMessageResources(messages.filter((message) => !preservedMessageIds.has(message.id)));
}

function messageAttachmentNames(message: ThreadMessage) {
  return [
    ...(message.media ?? []).map((media) => media.title ?? ''),
    ...(message.files ?? []).map((file) => file.name),
  ].filter(Boolean).sort();
}

function representsSamePendingUserTurn(
  serverMessage: ThreadMessage,
  transientMessage: ThreadMessage,
) {
  if (
    !transientMessage.id.startsWith('pending-user-')
    || serverMessage.role !== 'user'
    || transientMessage.role !== 'user'
    || serverMessage.threadId !== transientMessage.threadId
    || normalizeInlineText(serverMessage.content) !== normalizeInlineText(transientMessage.content)
  ) {
    return false;
  }

  const serverTimestamp = Date.parse(serverMessage.createdAt);
  const transientTimestamp = Date.parse(transientMessage.createdAt);
  if (
    !Number.isFinite(serverTimestamp)
    || !Number.isFinite(transientTimestamp)
    || Math.abs(serverTimestamp - transientTimestamp) > 5 * 60 * 1000
  ) {
    return false;
  }

  const serverAttachmentNames = messageAttachmentNames(serverMessage);
  const transientAttachmentNames = messageAttachmentNames(transientMessage);
  return serverAttachmentNames.length === transientAttachmentNames.length
    && serverAttachmentNames.every((name, index) => name === transientAttachmentNames[index]);
}

function mergeThreadMessages(
  serverMessages: ThreadMessage[],
  transientMessages: ThreadMessage[],
) {
  const serverMessageIds = new Set(serverMessages.map((message) => message.id));
  return [
    ...serverMessages,
    ...transientMessages.filter((message) => (
      !serverMessageIds.has(message.id)
      && !serverMessages.some((serverMessage) => representsSamePendingUserTurn(serverMessage, message))
    )),
  ];
}

/**
 * Transcript projection can briefly lag the terminal SSE event after an
 * interactive tool resumes. Do not replace a fully rendered live reply with
 * that older, partial projection during the post-stream refresh.
 */
export function preserveCompletedLiveReplies(
  currentMessages: ThreadMessage[],
  refreshedMessages: ThreadMessage[],
): ThreadMessage[] {
  const currentById = new Map(currentMessages.map((message) => [message.id, message]));

  return refreshedMessages.map((refreshedMessage) => {
    const currentMessage = currentById.get(refreshedMessage.id);
    if (
      !currentMessage
      || currentMessage.role !== 'assistant'
      || currentMessage.streaming
    ) {
      return refreshedMessage;
    }

    const liveReply = deriveMessageContentFromBlocks(currentMessage.blocks, currentMessage.content).trim();
    const refreshedReply = deriveMessageContentFromBlocks(
      refreshedMessage.blocks,
      refreshedMessage.content,
    ).trim();
    if (!liveReply || refreshedReply) {
      return refreshedMessage;
    }

    return {
      ...refreshedMessage,
      content: liveReply,
      reasoning: refreshedMessage.reasoning ?? currentMessage.reasoning,
      blocks: reconcileCompletedReplyBlock(
        refreshedMessage.blocks,
        currentMessage.blocks,
        liveReply,
      ),
      raw: refreshedMessage.raw ?? currentMessage.raw,
      streaming: false,
    };
  });
}

export function hasCompletedInteractiveToolReply(
  messages: ThreadMessage[],
  toolUseId: string,
) {
  const questionIndex = messages.findIndex((message) => (
    message.role === 'assistant'
    && message.blocks?.some((block) => (
      block.type === 'ask_question' && block.toolUseId === toolUseId
    ))
  ));
  if (questionIndex < 0) {
    return false;
  }

  const questionMessage = messages[questionIndex]!;
  const questionBlockIndex = questionMessage.blocks?.findIndex((block) => (
    block.type === 'ask_question' && block.toolUseId === toolUseId
  )) ?? -1;
  const isTerminalAssistantMessage = (message: ThreadMessage) => (
    message.role === 'assistant'
    && message.stopReason !== 'tool_use'
  );

  // The first terminal stream event may contain an interim "Assistant is
  // thinking..." reply alongside the question.  It is not a continuation of
  // the tool call, so only text blocks that follow the question are terminal.
  if (isTerminalAssistantMessage(questionMessage)
    && questionBlockIndex >= 0
    && questionMessage.blocks?.slice(questionBlockIndex + 1).some((block) => (
    block.type === 'text' && Boolean(block.text?.trim())
  ))) {
    return true;
  }

  // Some transcript projections keep the continuation as a later assistant
  // record instead of merging it into the question message.
  return messages.slice(questionIndex + 1).some((message) => (
    isTerminalAssistantMessage(message)
    && Boolean(deriveMessageContentFromBlocks(message.blocks, message.content).trim())
  ));
}

function normalizeInlineText(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function readSkillResults(raw: Record<string, unknown> | null | undefined): SkillResult[] {
  return Array.isArray(raw?.skillResults)
    ? raw.skillResults.filter((value): value is SkillResult => (
      typeof value === 'object'
      && value !== null
      && typeof (value as SkillResult).skillCallId === 'string'
    ))
    : [];
}

export function mergeMessageRaw(
  current: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const currentResults = readSkillResults(current);
  const incomingResults = readSkillResults(incoming);
  if (!currentResults.length && !incomingResults.length) {
    return incoming;
  }
  const resultsByCallId = new Map<string, SkillResult>();
  for (const result of [...currentResults, ...incomingResults]) {
    resultsByCallId.set(result.skillCallId, result);
  }
  return {
    ...(current ?? {}),
    ...(incoming ?? {}),
    skillResults: Array.from(resultsByCallId.values()),
  };
}

function deriveThreadSeed(submission: DraftMessageSubmission) {
  const normalizedContent = normalizeInlineText(submission.content);

  if (normalizedContent) {
    return {
      title: truncateText(normalizedContent, 18),
      preview: truncateText(normalizedContent, 72),
    };
  }

  if (submission.attachments.length === 1) {
    const attachmentName = submission.attachments[0]?.name.trim() || '附件';
    return {
      title: truncateText(attachmentName, 18),
      preview: `包含附件：${truncateText(attachmentName, 56)}`,
    };
  }

  if (submission.attachments.length > 1) {
    return {
      title: '多附件对话',
      preview: `包含 ${submission.attachments.length} 个附件`,
    };
  }

  return {
    title: '新对话',
    preview: '',
  };
}

function mergeById<T extends { id: string }>(existing: T[] | undefined, incoming: T[] | undefined) {
  const merged = new Map<string, T>();

  for (const item of existing ?? []) {
    merged.set(item.id, item);
  }

  for (const item of incoming ?? []) {
    merged.set(item.id, {
      ...merged.get(item.id),
      ...item,
    });
  }

  return merged.size ? [...merged.values()] : undefined;
}

function appendText(existing: string | null | undefined, delta: string) {
  return `${existing ?? ''}${delta}`;
}

function deriveMessageContentFromBlocks(blocks: MessageBlock[] | undefined, fallback = '') {
  const textBlocks = (blocks ?? []).filter((block) => block.type === 'text');
  const text = textBlocks[textBlocks.length - 1]?.text?.trim();
  return text || fallback;
}

function reconcileCompletedReplyBlock(
  existingBlocks: MessageBlock[] | undefined,
  completedBlocks: MessageBlock[] | undefined,
  reply: string,
) {
  const mergedBlocks = [...(existingBlocks ?? [])];
  for (const block of completedBlocks ?? []) {
    const existingIndex = mergedBlocks.findIndex((candidate) => candidate.id === block.id);
    if (existingIndex < 0) {
      mergedBlocks.push(block);
    } else {
      mergedBlocks[existingIndex] = block.type === 'artifact'
        ? mergeMessageBlock(mergedBlocks[existingIndex], block)
        : { ...mergedBlocks[existingIndex], ...block };
    }
  }
  return normalizeMessageBlocks(mergedBlocks, { authoritativeText: reply });
}

function mergeMessageBlock(existing: MessageBlock | undefined, incoming: MessageBlock): MessageBlock {
  if (!existing) {
    return incoming;
  }

  return {
    ...existing,
    ...incoming,
    text: incoming.text !== undefined ? incoming.text : existing.text,
    media: mergeById(existing.media, incoming.media),
    files: mergeById(existing.files, incoming.files),
    actions: mergeById(existing.actions, incoming.actions),
  };
}

function upsertMessageBlock(
  blocks: MessageBlock[] | undefined,
  incoming: MessageBlock,
) {
  const nextBlocks = [...(blocks ?? [])];
  const index = nextBlocks.findIndex((block) => block.id === incoming.id);
  if (index < 0) {
    nextBlocks.push(incoming);
    return nextBlocks;
  }

  nextBlocks[index] = mergeMessageBlock(nextBlocks[index], incoming);
  return nextBlocks;
}

function appendMessageBlockDelta(
  blocks: MessageBlock[] | undefined,
  input: {
    blockId: string;
    blockType: MessageBlockType;
    delta?: string;
    block?: MessageBlock;
  },
) {
  const baseBlock: MessageBlock = input.block ?? {
    id: input.blockId,
    type: input.blockType,
  };
  const nextBlocks = [...(blocks ?? [])];
  const index = nextBlocks.findIndex((block) => block.id === input.blockId);
  if (index < 0) {
    nextBlocks.push({
      ...baseBlock,
      text: input.delta ? appendText(baseBlock.text, input.delta) : baseBlock.text,
    });
    return nextBlocks;
  }

  const existing = nextBlocks[index];
  nextBlocks[index] = mergeMessageBlock(existing, {
    ...baseBlock,
    text: input.delta ? appendText(existing.text, input.delta) : baseBlock.text,
  });
  return nextBlocks;
}

function createUploadedFileMedia(uploadedFiles: UploadedConversationFile[]): MessageMedia[] {
  return uploadedFiles
    .filter((file) => file.kind === 'image' || file.kind === 'video')
    .map((file) => ({
      id: file.assetId,
      kind: file.kind,
      url: file.url,
      title: file.title,
      mimeType: file.mimeType,
    }));
}

function createUploadedFileAttachments(uploadedFiles: UploadedConversationFile[]): MessageFileAttachment[] {
  return uploadedFiles
    .filter((file) => file.kind === 'file')
    .map((file) => ({
      id: file.assetId,
      name: file.title || file.originalName,
      url: file.url,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
    }));
}

interface WorkspaceState {
  initialized: boolean;
  threads: ThreadSummary[];
  messages: ThreadMessage[];
  profile: ProfileRecord | null;
  profileSuggestions: ProfileSuggestion[];
  artifacts: ArtifactRecord[];
  activeThreadId: string | null;
  activeArtifactId: string | null;
  sideRailCollapsed: boolean;
  mobileSideRailOpen: boolean;
  artifactPaneOpen: boolean;
  artifactViewMode: ArtifactViewMode;
  threadsStatus: LoadState;
  threadCreateStatus: LoadState;
  threadDeleteStatus: LoadState;
  messagesStatus: LoadState;
  profileStatus: LoadState;
  profileSuggestionsStatus: LoadState;
  profileSaveStatus: LoadState;
  artifactsStatus: LoadState;
  messageSubmitStatusByThread: Record<string, LoadState>;
  transientMessagesByThread: Record<string, ThreadMessage[]>;
  errorMessage: string | null;
}

export const useWorkspaceStore = defineStore('workspace', {
  state: (): WorkspaceState => ({
    initialized: false,
    threads: [],
    messages: [],
    profile: null,
    profileSuggestions: [],
    artifacts: [],
    activeThreadId: null,
    activeArtifactId: null,
    sideRailCollapsed: false,
    mobileSideRailOpen: false,
    artifactPaneOpen: false,
    artifactViewMode: 'pane',
    threadsStatus: 'idle',
    threadCreateStatus: 'idle',
    threadDeleteStatus: 'idle',
    messagesStatus: 'idle',
    profileStatus: 'idle',
    profileSuggestionsStatus: 'idle',
    profileSaveStatus: 'idle',
    artifactsStatus: 'idle',
    messageSubmitStatusByThread: {},
    transientMessagesByThread: {},
    errorMessage: null,
  }),
  getters: {
    activeThread(state) {
      return state.threads.find((thread) => thread.id === state.activeThreadId) ?? null;
    },
    activeArtifact(state) {
      return state.artifacts.find((artifact) => artifact.id === state.activeArtifactId) ?? null;
    },
    artifactFocusMode(state) {
      return state.artifactPaneOpen && state.artifactViewMode === 'focus';
    },
    artifactImmersiveMode(state) {
      return state.artifactPaneOpen && state.artifactViewMode === 'immersive';
    },
    messageSubmitStatus(state): LoadState {
      if (!state.activeThreadId) {
        return 'idle';
      }

      return state.messageSubmitStatusByThread[state.activeThreadId] ?? 'idle';
    },
    messageSubmitThreadId(state) {
      if (!state.activeThreadId) {
        return null;
      }

      return state.messageSubmitStatusByThread[state.activeThreadId] === 'loading'
        ? state.activeThreadId
        : null;
    },
  },
  actions: {
    setSideRailCollapsed(collapsed: boolean) {
      this.sideRailCollapsed = collapsed;
    },
    toggleSideRailCollapsed() {
      this.sideRailCollapsed = !this.sideRailCollapsed;
    },
    setMobileSideRailOpen(open: boolean) {
      this.mobileSideRailOpen = open;
    },
    openMobileSideRail() {
      this.mobileSideRailOpen = true;
    },
    closeMobileSideRail() {
      this.mobileSideRailOpen = false;
    },
    toggleMobileSideRail() {
      this.mobileSideRailOpen = !this.mobileSideRailOpen;
    },
    resetWorkspace() {
      revokeUnpreservedMessageResources(this.messages, {});
      revokeLocalMessageResources(Object.values(this.transientMessagesByThread).flat());
      initializePromise = null;
      threadLoadRequestToken += 1;
      artifactRefreshRequestToken += 1;
      this.$reset();
    },
    syncArtifactViewForLayout(isMobileLayout: boolean) {
      if (!this.artifactPaneOpen || !this.activeArtifactId || this.artifactViewMode === 'immersive') {
        return;
      }

      if (isMobileLayout && this.artifactViewMode === 'pane') {
        this.artifactViewMode = 'focus';
        return;
      }

      if (!isMobileLayout && this.artifactViewMode === 'focus') {
        this.artifactViewMode = 'pane';
      }
    },
    upsertArtifactRecord(nextArtifact: ArtifactRecord) {
      const artifactIndex = this.artifacts.findIndex((artifact) => artifact.id === nextArtifact.id);

      if (artifactIndex >= 0) {
        this.artifacts[artifactIndex] = nextArtifact;
      } else {
        this.artifacts.push(nextArtifact);
      }
    },
    setArtifactStatus(artifactId: string, status: ArtifactStatus) {
      const artifactIndex = this.artifacts.findIndex((artifact) => artifact.id === artifactId);

      if (artifactIndex < 0) {
        return;
      }

      this.artifacts[artifactIndex] = {
        ...this.artifacts[artifactIndex],
        status,
      };
    },
    async initialize() {
      if (this.initialized) {
        return;
      }

      if (initializePromise) {
        await initializePromise;
        return;
      }

      initializePromise = (async () => {
        this.threadsStatus = 'loading';
        this.profileStatus = 'loading';
        this.profileSuggestionsStatus = 'loading';
        this.artifactsStatus = 'loading';
        this.errorMessage = null;

        try {
          const [threads, profile, profileSuggestions, artifacts] = await Promise.all([
            client.listThreads(),
            client.getProfile(),
            client.listProfileSuggestions(),
            client.listArtifacts(),
          ]);

          this.threads = threads;
          this.profile = profile;
          this.profileSuggestions = profileSuggestions;
          this.artifacts = artifacts;
          this.activeThreadId ??= threads[0]?.id ?? null;
          this.initialized = true;

          this.threadsStatus = 'ready';
          this.threadCreateStatus = 'idle';
          this.threadDeleteStatus = 'idle';
          this.profileStatus = 'ready';
          this.profileSuggestionsStatus = 'ready';
          this.artifactsStatus = 'ready';
          this.messagesStatus = 'idle';
          this.profileSaveStatus = 'idle';
        } catch (error) {
          this.threadsStatus = 'error';
          this.threadCreateStatus = 'error';
          this.threadDeleteStatus = 'error';
          this.profileStatus = 'error';
          this.profileSuggestionsStatus = 'error';
          this.artifactsStatus = 'error';
          this.messagesStatus = 'error';
          this.errorMessage = error instanceof Error ? error.message : 'Unknown initialization error';
        } finally {
          initializePromise = null;
        }
      })();

      await initializePromise;
    },
    async setActiveThread(threadId: string) {
      if (this.activeThreadId === threadId && (this.messagesStatus === 'loading' || this.messagesStatus === 'ready')) {
        return this.activeThreadId;
      }

      const requestToken = ++threadLoadRequestToken;

      this.messagesStatus = 'loading';
      this.errorMessage = null;
      revokeUnpreservedMessageResources(this.messages, this.transientMessagesByThread);
      this.messages = [];

      await this.initialize();

      if (!this.initialized || requestToken !== threadLoadRequestToken) {
        return null;
      }

      const targetThreadId = this.threads.some((thread) => thread.id === threadId)
        ? threadId
        : this.threads[0]?.id ?? null;

      if (!targetThreadId) {
        this.activeThreadId = null;
        this.messagesStatus = 'ready';
        return null;
      }

      if (this.activeThreadId !== targetThreadId) {
        this.closeArtifact();
      }

      this.activeThreadId = targetThreadId;
      this.closeMobileSideRail();

      try {
        const nextMessages = await client.getThreadMessages(targetThreadId);

        if (requestToken !== threadLoadRequestToken || this.activeThreadId !== targetThreadId) {
          return null;
        }

        revokeUnpreservedMessageResources(this.messages, this.transientMessagesByThread);
        this.messages = mergeThreadMessages(
          nextMessages,
          this.transientMessagesByThread[targetThreadId] ?? [],
        );
        this.messagesStatus = 'ready';

        return targetThreadId;
      } catch (error) {
        if (requestToken !== threadLoadRequestToken || this.activeThreadId !== targetThreadId) {
          return null;
        }

        revokeUnpreservedMessageResources(this.messages, this.transientMessagesByThread);
        this.messages = [];
        this.messagesStatus = 'error';
        this.errorMessage = error instanceof Error ? error.message : 'Unknown message loading error';
        return null;
      }
    },
    async createThread(input?: { title?: string; preview?: string }) {
      await this.initialize();

      if (!this.initialized) {
        throw new Error(this.errorMessage ?? 'Workspace is not initialized.');
      }

      this.threadCreateStatus = 'loading';
      this.errorMessage = null;

      try {
        const nextThread = await client.createThread({
          title: input?.title ?? '新对话',
          preview: input?.preview ?? '',
        });

        this.threads = [
          nextThread,
          ...this.threads.filter((thread) => thread.id !== nextThread.id),
        ];
        this.activeThreadId = nextThread.id;
        this.closeMobileSideRail();
        this.closeArtifact();
        revokeUnpreservedMessageResources(this.messages, this.transientMessagesByThread);
        this.messages = [];
        this.messagesStatus = 'idle';
        this.threadCreateStatus = 'ready';

        return nextThread;
      } catch (error) {
        this.threadCreateStatus = 'error';
        this.errorMessage = error instanceof Error ? error.message : 'Unknown thread creation error';
        throw error;
      }
    },
    async startThreadFromDraft(submission: DraftMessageSubmission | string) {
      const nextSubmission = typeof submission === 'string'
        ? { content: submission, attachments: [] }
        : submission;
      const content = nextSubmission.content.trim();

      if (!content && nextSubmission.attachments.length === 0) {
        return null;
      }

      try {
        const nextThread = await this.createThread(deriveThreadSeed(nextSubmission));
        void this.submitDraftMessage({
          content: nextSubmission.content,
          attachments: [...nextSubmission.attachments],
        });
        return nextThread;
      } catch (error) {
        throw error;
      }
    },
    async deleteThread(threadId: string) {
      await this.initialize();

      if (!this.initialized) {
        throw new Error(this.errorMessage ?? 'Workspace is not initialized.');
      }

      this.threadDeleteStatus = 'loading';
      this.errorMessage = null;

      try {
        await client.deleteThread(threadId);

        this.threads = this.threads.filter((thread) => thread.id !== threadId);
        revokeLocalMessageResources(this.transientMessagesByThread[threadId] ?? []);
        delete this.transientMessagesByThread[threadId];
        delete this.messageSubmitStatusByThread[threadId];

        if (this.activeThreadId === threadId) {
          revokeUnpreservedMessageResources(this.messages, this.transientMessagesByThread);
          this.messages = [];
          this.activeThreadId = this.threads[0]?.id ?? null;
          this.messagesStatus = 'idle';
          this.closeArtifact();
        }

        this.threadDeleteStatus = 'ready';
        return this.activeThreadId;
      } catch (error) {
        this.threadDeleteStatus = 'error';
        this.errorMessage = error instanceof Error ? error.message : 'Unknown thread deletion error';
        throw error;
      }
    },
    async openArtifact(artifactId: string, viewMode: ArtifactViewMode = 'pane') {
      await this.initialize();

      const artifact = await client.getArtifact(artifactId);

      if (!artifact) {
        return;
      }

      this.upsertArtifactRecord(artifact);

      this.activeArtifactId = artifact.id;
      this.artifactPaneOpen = true;
      this.artifactViewMode = matchesMobileLayoutViewport() && viewMode === 'pane'
        ? 'focus'
        : viewMode;
      this.closeMobileSideRail();
    },
    promoteArtifactFocus() {
      if (!this.activeArtifactId) {
        return;
      }

      this.artifactPaneOpen = true;
      this.artifactViewMode = 'focus';
    },
    promoteArtifactImmersive() {
      if (!this.activeArtifactId) {
        return;
      }

      this.artifactPaneOpen = true;
      this.artifactViewMode = 'immersive';
    },
    restoreArtifactFocus() {
      if (!this.activeArtifactId) {
        return;
      }

      this.artifactPaneOpen = true;
      this.artifactViewMode = 'focus';
    },
    restoreArtifactPane() {
      if (!this.activeArtifactId) {
        return;
      }

      this.artifactPaneOpen = true;
      this.artifactViewMode = 'pane';
    },
    async refreshArtifact(artifactId?: string | null) {
      await this.initialize();

      const targetArtifactId = artifactId ?? this.activeArtifactId;

      if (!targetArtifactId) {
        return;
      }

      const requestToken = ++artifactRefreshRequestToken;

      this.errorMessage = null;
      this.setArtifactStatus(targetArtifactId, 'loading');

      if (simulateArtifactRefreshLifecycle) {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 180));

        if (requestToken !== artifactRefreshRequestToken) {
          return;
        }

        this.setArtifactStatus(targetArtifactId, 'streaming');

        await new Promise((resolve) => globalThis.setTimeout(resolve, 260));

        if (requestToken !== artifactRefreshRequestToken) {
          return;
        }
      }

      try {
        const refreshedArtifact = await client.refreshArtifact(targetArtifactId);

        if (requestToken !== artifactRefreshRequestToken) {
          return;
        }

        if (!refreshedArtifact) {
          this.setArtifactStatus(targetArtifactId, 'error');
          this.errorMessage = 'Artifact refresh returned no revision payload.';
          return;
        }

        this.upsertArtifactRecord(refreshedArtifact);
        this.errorMessage = null;
      } catch (error) {
        if (requestToken !== artifactRefreshRequestToken) {
          return;
        }

        this.setArtifactStatus(targetArtifactId, 'error');
        this.errorMessage = error instanceof Error ? error.message : 'Unknown artifact refresh error';
      }
    },
    async saveProfileDraft(
      nextProfile: ProfileRecord,
      suggestionRowId?: number,
    ) {
      await this.initialize();
      this.profileSaveStatus = 'loading';
      this.errorMessage = null;

      try {
        const savedProfile = await client.updateProfile(
          nextProfile,
          { suggestionRowId },
        );
        const refreshedProfileSummary = await client.getArtifact('artifact-profile-summary');

        this.profile = savedProfile;
        if (suggestionRowId) {
          this.profileSuggestions = this.profileSuggestions.filter(
            (suggestion) => suggestion.rowId !== suggestionRowId,
          );
        }

        if (refreshedProfileSummary) {
          this.upsertArtifactRecord(refreshedProfileSummary);

          if (this.activeArtifactId === refreshedProfileSummary.id) {
            this.activeArtifactId = refreshedProfileSummary.id;
          }
        }

        this.profileSaveStatus = 'ready';
        return savedProfile;
      } catch (error) {
        this.profileSaveStatus = 'error';
        this.errorMessage = error instanceof Error ? error.message : 'Unknown profile save error';
        throw error;
      }
    },
    async submitDraftMessage(submission: DraftMessageSubmission | string) {
      const nextSubmission = typeof submission === 'string'
        ? { content: submission, attachments: [] }
        : submission;
      const content = nextSubmission.content.trim();
      const attachments = nextSubmission.attachments;

      if (!this.activeThreadId || (!content && attachments.length === 0)) {
        return;
      }

      const targetThreadId = this.activeThreadId;

      if (this.messageSubmitStatusByThread[targetThreadId] === 'loading') {
        return;
      }

      const timestamp = formatLocalTimestamp(new Date());
      const pendingMessageId = createMessageId('pending-user');
      const media = attachments
        .filter((attachment) => attachment.kind === 'image')
        .map((attachment) => ({
          id: attachment.id,
          kind: 'image' as const,
          url: attachment.url,
          title: attachment.name,
          alt: `用户上传图片：${attachment.name}`,
          mimeType: attachment.mimeType,
          caption: '正在上传并发送...',
        }));
      const files = attachments
        .filter((attachment) => attachment.kind === 'file')
        .map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          url: attachment.url,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        }));

      if (this.messagesStatus !== 'ready') {
        this.messagesStatus = 'ready';
      }
      this.messageSubmitStatusByThread[targetThreadId] = 'loading';
      this.errorMessage = null;
      const pendingMessage: ThreadMessage = {
        id: pendingMessageId,
        threadId: targetThreadId,
        role: 'user',
        kind: 'markdown',
        content: content || '（已添加附件）',
        media: media.length ? media : undefined,
        files: files.length ? files : undefined,
        createdAt: timestamp,
      };
      this.transientMessagesByThread[targetThreadId] = [
        ...(this.transientMessagesByThread[targetThreadId] ?? []),
        pendingMessage,
      ];
      this.messages.push(pendingMessage);

      const reportSubmissionError = (
        stage: 'upload' | 'send' | 'refresh',
        error: unknown,
      ) => {
        this.messageSubmitStatusByThread[targetThreadId] = 'error';
        this.messages = this.messages.map((message) => (
          message.threadId === targetThreadId && message.role === 'assistant' && message.streaming
            ? { ...message, streaming: false }
            : message
        ));
        const rawMessage = error instanceof Error ? error.message : 'Unknown message sending error';
        const stageMessage = stage === 'upload'
          ? '附件上传失败'
          : stage === 'send'
            ? '消息发送失败'
            : '消息已发送，但刷新消息列表失败';

        const errorMessage: ThreadMessage = {
          id: createMessageId('send-error'),
          threadId: targetThreadId,
          role: 'system',
          kind: 'status',
          content: `${stageMessage}：${rawMessage}`,
          createdAt: formatLocalTimestamp(new Date()),
        };
        this.transientMessagesByThread[targetThreadId] = [
          ...(this.transientMessagesByThread[targetThreadId] ?? []),
          errorMessage,
        ];

        if (this.activeThreadId !== targetThreadId) {
          return;
        }

        this.messagesStatus = 'ready';
        this.errorMessage = rawMessage;
        this.messages.push(errorMessage);
      };

      let uploadedFiles: UploadedConversationFile[];
      try {
        uploadedFiles = [];

        // Upload serially so the current backend manifest writer cannot drop
        // sibling attachments from the same user turn.
        for (const attachment of attachments) {
          uploadedFiles.push(await client.uploadThreadFile(targetThreadId, attachment));
        }
      } catch (error) {
        reportSubmissionError('upload', error);
        return;
      }

      const clientRequestId = createMessageId('request');
      const messageContent = content || '（已添加附件）';
      const refreshThreadMessages = async () => {
        const nextMessages = await client.getThreadMessages(targetThreadId);
        const reconciledMessages = preserveCompletedLiveReplies(this.messages, nextMessages);

        revokeLocalMessageResources(this.transientMessagesByThread[targetThreadId] ?? []);
        delete this.transientMessagesByThread[targetThreadId];
        this.messageSubmitStatusByThread[targetThreadId] = 'ready';

        if (this.activeThreadId !== targetThreadId) {
          return false;
        }

        revokeLocalMessageResources(this.messages);
        this.messages = reconciledMessages;
        this.messagesStatus = 'ready';
        return true;
      };
      const sendBufferedAndRefresh = async () => {
        const sendResult = await client.sendMessage(targetThreadId, {
          kind: 'markdown',
          content: messageContent,
          attachmentAssetIds: uploadedFiles.map((file) => file.assetId),
          clientRequestId,
        });

        if (!sendResult.accepted || sendResult.status === 'failed') {
          throw new Error(!sendResult.accepted ? '消息未被服务端接受' : '消息发送失败');
        }

        try {
          await refreshThreadMessages();
        } catch (error) {
          reportSubmissionError('refresh', error);
        }
      };
      const ensureAssistantMessage = (assistantMessageId: string, createdAt = formatLocalTimestamp(new Date())) => {
        const existingIndex = this.messages.findIndex((message) => message.id === assistantMessageId);
        if (existingIndex >= 0) {
          return existingIndex;
        }

        this.messages.push({
          id: assistantMessageId,
          threadId: targetThreadId,
          role: 'assistant',
          kind: 'markdown',
          content: '',
          reasoning: null,
          blocks: [],
          streaming: true,
          createdAt,
        });

        return this.messages.length - 1;
      };
      const mergeAssistantPayload = (
        assistantMessageId: string,
        payload: {
          content?: string;
          reasoning?: string | null;
          media?: MessageMedia[];
          files?: MessageFileAttachment[];
          actions?: MessageAction[];
          model?: string | null;
          usage?: Record<string, unknown> | null;
          stopReason?: string | null;
          blocks?: MessageBlock[];
          raw?: Record<string, unknown> | null;
          streaming?: boolean;
          createdAt?: string;
        },
      ) => {
        const index = ensureAssistantMessage(assistantMessageId, payload.createdAt);
        const existingMessage = this.messages[index];

        this.messages[index] = {
          ...existingMessage,
          content: payload.content ?? existingMessage.content,
          reasoning: payload.reasoning !== undefined ? payload.reasoning : existingMessage.reasoning,
          media: mergeById(existingMessage.media, payload.media),
          files: mergeById(existingMessage.files, payload.files),
          actions: mergeById(existingMessage.actions, payload.actions),
          model: payload.model !== undefined ? payload.model : existingMessage.model,
          usage: payload.usage !== undefined ? payload.usage : existingMessage.usage,
          stopReason: payload.stopReason !== undefined ? payload.stopReason : existingMessage.stopReason,
          blocks: payload.blocks !== undefined
            ? normalizeMessageBlocks(payload.blocks)
            : normalizeMessageBlocks(existingMessage.blocks),
          raw: payload.raw !== undefined
            ? mergeMessageRaw(existingMessage.raw, payload.raw)
            : existingMessage.raw,
          streaming: payload.streaming !== undefined ? payload.streaming : existingMessage.streaming,
        };
      };
      const mergePendingUserMessage = (serverUserMessageId: string, createdAt?: string) => {
        if (!serverUserMessageId) {
          return;
        }

        const pendingIndex = this.messages.findIndex((message) => message.id === pendingMessageId);
        if (pendingIndex < 0) {
          return;
        }

        const uploadedMedia = createUploadedFileMedia(uploadedFiles);
        const uploadedAttachments = createUploadedFileAttachments(uploadedFiles);
        this.messages[pendingIndex] = {
          ...this.messages[pendingIndex],
          id: serverUserMessageId,
          createdAt: createdAt ?? this.messages[pendingIndex].createdAt,
          media: uploadedMedia.length ? uploadedMedia : this.messages[pendingIndex].media,
          files: uploadedAttachments.length ? uploadedAttachments : this.messages[pendingIndex].files,
        };
      };
      const structuredTextMessageIds = new Set<string>();
      const legacyReplyMessageIds = new Set<string>();
      const showSkillLoaded = (
        messageId: string,
        skillName: string,
        sourceBlockId?: string,
        clearReasoning = false,
      ) => {
        const index = ensureAssistantMessage(messageId);
        const retainedBlocks = (this.messages[index].blocks ?? []).filter((block) => {
          if (block.id === sourceBlockId) return false;
          if (sourceBlockId === 'legacy-text-0' && block.type === 'text') return false;
          if (clearReasoning && block.type === 'status' && block.title === THINKING_BLOCK_TITLE) {
            return false;
          }
          return true;
        });
        const blocks = normalizeMessageBlocks([
          ...retainedBlocks,
          createSkillLoadedBlock(skillName),
        ]);
        this.messages[index] = {
          ...this.messages[index],
          blocks,
          content: deriveMessageContentFromBlocks(blocks, ''),
          reasoning: clearReasoning ? null : this.messages[index].reasoning,
        };
      };
      const applyStreamEvent = (event: ThreadMessageStreamEvent) => {
        if (event.type === 'message.created') {
          mergePendingUserMessage(event.messageId, event.createdAt);
          ensureAssistantMessage(event.assistantMessageId, event.createdAt);
          return;
        }

        if (event.type === 'reasoning.delta') {
          const skillName = extractSkillName(event.delta);
          if (skillName) {
            showSkillLoaded(event.messageId, skillName, 'legacy-status-0', true);
            return;
          }
          const index = ensureAssistantMessage(event.messageId);
          if ((this.messages[index].blocks?.length ?? 0) > 0) {
            return;
          }
          const blocks = appendMessageBlockDelta(this.messages[index].blocks, {
            blockId: 'legacy-status-0',
            blockType: 'status',
            delta: event.delta,
            block: {
              id: 'legacy-status-0',
              type: 'status',
              title: THINKING_BLOCK_TITLE,
              text: '',
            },
          });
          this.messages[index] = {
            ...this.messages[index],
            blocks,
            reasoning: appendText(this.messages[index].reasoning, event.delta),
          };
          return;
        }

        if (event.type === 'reply.delta') {
          const skillName = extractSkillName(event.delta);
          if (skillName) {
            showSkillLoaded(event.messageId, skillName, 'legacy-text-0');
            return;
          }
          const index = ensureAssistantMessage(event.messageId);
          if (structuredTextMessageIds.has(event.messageId)) {
            return;
          }
          legacyReplyMessageIds.add(event.messageId);
          const blocks = appendMessageBlockDelta(this.messages[index].blocks, {
            blockId: 'legacy-text-0',
            blockType: 'text',
            delta: event.delta,
            block: {
              id: 'legacy-text-0',
              type: 'text',
              text: '',
            },
          });
          this.messages[index] = {
            ...this.messages[index],
            blocks,
            content: appendText(this.messages[index].content, event.delta),
          };
          return;
        }

        if (event.type === 'message.block.delta') {
          const skillName = extractSkillNameFromBlock(event.block)
            ?? extractSkillName(event.delta);
          if (skillName) {
            showSkillLoaded(event.messageId, skillName, event.blockId);
            return;
          }
          if (event.blockType === 'skill' || isInternalSkillBlock(event.block)) {
            return;
          }
          const index = ensureAssistantMessage(event.messageId);
          const isFirstStructuredTextDelta = event.blockType === 'text'
            && !structuredTextMessageIds.has(event.messageId);
          if (event.blockType === 'text') {
            structuredTextMessageIds.add(event.messageId);
          }
          const existingBlocks = isFirstStructuredTextDelta && legacyReplyMessageIds.has(event.messageId)
            ? this.messages[index].blocks?.filter((block) => block.id !== 'legacy-text-0')
            : this.messages[index].blocks;
          const blocks = appendMessageBlockDelta(existingBlocks, {
            blockId: event.blockId,
            blockType: event.blockType,
            delta: event.delta,
            block: event.block,
          });
          this.messages[index] = {
            ...this.messages[index],
            blocks,
            content: deriveMessageContentFromBlocks(
              blocks,
              isFirstStructuredTextDelta && legacyReplyMessageIds.has(event.messageId)
                ? ''
                : this.messages[index].content,
            ),
          };
          return;
        }

        if (event.type === 'message.block.completed') {
          const skillName = extractSkillNameFromBlock(event.block);
          if (skillName) {
            showSkillLoaded(event.messageId, skillName, event.block.id);
            return;
          }
          if (isInternalSkillBlock(event.block)) {
            return;
          }
          const index = ensureAssistantMessage(event.messageId);
          const blocks = upsertMessageBlock(this.messages[index].blocks, event.block);
          this.messages[index] = {
            ...this.messages[index],
            blocks,
            content: deriveMessageContentFromBlocks(blocks, this.messages[index].content),
          };
          return;
        }

        if (event.type === 'skill.completed') {
          const index = ensureAssistantMessage(event.messageId);
          const currentRaw = this.messages[index].raw;
          const skillResult: SkillResult = {
            skillCallId: event.skillCallId,
            skillName: event.skillName,
            outcome: event.outcome,
            summary: event.summary,
            ...(event.result !== undefined ? { result: event.result } : {}),
            startedAt: event.startedAt,
            completedAt: event.completedAt,
            durationMs: event.durationMs,
            source: event.source,
          };
          this.messages[index] = {
            ...this.messages[index],
            raw: mergeMessageRaw(currentRaw, { skillResults: [skillResult] }),
          };
          return;
        }

        if (event.type === 'artifact.created') {
          const artifactBlock: MessageBlock = {
            id: 'artifact-0',
            type: 'artifact',
            title: '生成内容',
            text: event.media?.length ? '已生成可打开的内容。' : undefined,
            media: event.media,
            files: event.files,
            actions: event.actions,
          };
          const index = ensureAssistantMessage(event.messageId);
          const blocks = upsertMessageBlock(this.messages[index].blocks, artifactBlock);
          mergeAssistantPayload(event.messageId, {
            media: event.media,
            files: event.files,
            actions: event.actions,
            blocks,
          });
          return;
        }

        if (event.type === 'message.completed') {
          mergePendingUserMessage(event.messageId);
          const existingBlocks = this.messages.find(
            (message) => message.id === event.assistantMessageId,
          )?.blocks;
          mergeAssistantPayload(event.assistantMessageId, {
            content: event.reply,
            reasoning: event.reasoning ?? undefined,
            media: event.media,
            files: event.files,
            actions: event.actions,
            model: event.model,
            usage: event.usage,
            stopReason: event.stopReason,
            blocks: reconcileCompletedReplyBlock(
              existingBlocks,
              event.blocks,
              event.reply,
            ),
            raw: event.raw,
            streaming: false,
          });
          return;
        }

        if (event.type === 'error') {
          throw new Error(event.message);
        }
      };

      if (client.streamMessage) {
        const abortController = new AbortController();
        let streamStarted = false;
        let streamCompleted = false;

        try {
          for await (const event of client.streamMessage(targetThreadId, {
            kind: 'markdown',
            content: messageContent,
            attachmentAssetIds: uploadedFiles.map((file) => file.assetId),
            clientRequestId,
          }, { signal: abortController.signal })) {
            streamStarted = true;
            if (this.activeThreadId !== targetThreadId) {
              abortController.abort();
              return;
            }

            if (event.type === 'message.completed') {
              streamCompleted = true;
            }
            applyStreamEvent(event);
          }

          if (!streamCompleted) {
            throw new Error('消息流在完成事件到达前已断开，请重试。');
          }

          try {
            await refreshThreadMessages();
          } catch (error) {
            reportSubmissionError('refresh', error);
          }
          return;
        } catch (error) {
          if (!streamStarted && error instanceof MessageStreamUnavailableError) {
            try {
              await sendBufferedAndRefresh();
            } catch (fallbackError) {
              reportSubmissionError('send', fallbackError);
            }
            return;
          }

          reportSubmissionError('send', error);
          return;
        }
      }

      try {
        await sendBufferedAndRefresh();
      } catch (error) {
        reportSubmissionError('send', error);
      }
      return;

      try {
        const sendResult = await client.sendMessage(targetThreadId, {
          kind: 'markdown',
          content: content || '（已添加附件）',
          attachmentAssetIds: uploadedFiles.map((file) => file.assetId),
          clientRequestId,
        });

        if (!sendResult.accepted || sendResult.status === 'failed') {
          reportSubmissionError(
            'send',
            new Error(!sendResult.accepted ? '消息未被服务端接受' : '消息发送失败'),
          );
          return;
        }

        const acknowledgePendingMessage = (message: ThreadMessage) => (
          message.id === pendingMessageId
            ? { ...message, id: sendResult.messageId }
            : message
        );
        this.transientMessagesByThread[targetThreadId] = (
          this.transientMessagesByThread[targetThreadId] ?? []
        ).map(acknowledgePendingMessage);

        if (this.activeThreadId === targetThreadId) {
          this.messages = this.messages.map(acknowledgePendingMessage);
        }
      } catch (error) {
        reportSubmissionError('send', error);
        return;
      }

      let nextMessages;
      try {
        nextMessages = await client.getThreadMessages(targetThreadId);
      } catch (error) {
        reportSubmissionError('refresh', error);
        return;
      }

      if (this.activeThreadId !== targetThreadId) {
        revokeLocalMessageResources(this.transientMessagesByThread[targetThreadId] ?? []);
        delete this.transientMessagesByThread[targetThreadId];
        this.messageSubmitStatusByThread[targetThreadId] = 'ready';
        return;
      }

      // A route-driven refresh for this thread may have started before the
      // submission completed. Prevent that older response from replacing the
      // newly fetched post-send history.
      threadLoadRequestToken += 1;
      revokeLocalMessageResources(this.transientMessagesByThread[targetThreadId] ?? []);
      delete this.transientMessagesByThread[targetThreadId];
      revokeUnpreservedMessageResources(this.messages, this.transientMessagesByThread);
      this.messages = nextMessages;
      this.messagesStatus = 'ready';
      this.messageSubmitStatusByThread[targetThreadId] = 'ready';
    },
    async respondToInteractiveTool(
      threadId: string,
      toolUseId: string,
      response: AskQuestionResponse,
    ) {
      if (!client.respondToInteractiveTool) {
        throw new Error('当前服务不支持交互式问题。');
      }

      await client.respondToInteractiveTool(threadId, toolUseId, response);
      void this.recoverInteractiveToolReply(threadId, toolUseId);
    },
    async recoverInteractiveToolReply(threadId: string, toolUseId: string) {
      for (let attempt = 0; attempt < INTERACTIVE_TOOL_HISTORY_POLL_ATTEMPTS; attempt += 1) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, INTERACTIVE_TOOL_HISTORY_POLL_INTERVAL_MS);
        });

        let history: ThreadMessage[];
        try {
          history = await client.getThreadMessages(threadId);
        } catch {
          continue;
        }

        if (!hasCompletedInteractiveToolReply(history, toolUseId)) {
          continue;
        }

        if (this.activeThreadId !== threadId) {
          return;
        }

        // The original message stream performs one last history refresh when
        // it closes after a tool response.  Wait for that refresh before
        // applying the recovered terminal history, otherwise it can overwrite
        // the final reply with the interim tool-use placeholder.
        while (this.messageSubmitStatusByThread[threadId] === 'loading') {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, INTERACTIVE_TOOL_STREAM_SETTLE_INTERVAL_MS);
          });
        }

        try {
          history = await client.getThreadMessages(threadId);
        } catch {
          continue;
        }

        if (!hasCompletedInteractiveToolReply(history, toolUseId)) {
          continue;
        }

        const transientMessages = this.transientMessagesByThread[threadId] ?? [];
        const refreshedMessages = mergeThreadMessages(history, transientMessages);
        this.messages = preserveCompletedLiveReplies(this.messages, refreshedMessages);
        this.messagesStatus = 'ready';
        this.messageSubmitStatusByThread[threadId] = 'ready';
        return;
      }
    },
    closeArtifact() {
      this.artifactPaneOpen = false;
      this.activeArtifactId = null;
      this.artifactViewMode = 'pane';
    },
  },
});
