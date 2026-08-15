import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { detectOutputType } from '../../utils/detectOutputType.js';
import { createFileDownloadToken } from '../../utils/fileDownloadToken.js';
import { skillLogger } from '../../utils/skillLogger.js';
import {
  looksLikeServerPhysicalPath,
  sanitizeServerPhysicalPaths,
  sanitizeServerPhysicalPathsInValue,
} from '../../utils/publicOutputSanitizer.js';
import { DataSource, In, Repository } from 'typeorm';
import { AgentService } from '../agent/agent.service';
import type { AgentAskQuestion } from '../agent/agent.runtime.js';
import { SkillService } from '../skill/skill.service';
import type { SkillHandlerResult, SkillProgressEvent } from '../skill/skill.registry';
import { ArtifactService } from '../artifact/artifact.service';
import { ProfileService } from '../profile/profile.service';
import { ProfileEvidenceLinkEntity } from '../profile/entities/profile-evidence-link.entity';
import { ConversationTranscriptProjectionService } from './transcript-projection.service.js';
import {
  createSkillLoadedBlock,
  normalizeCanonicalMessageBlocks,
  THINKING_BLOCK_TITLE,
} from './canonical-message-blocks.js';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { SendMultimodalMessageDto } from './dto/send-multimodal-message.dto';
import { RespondToToolDto } from './dto/respond-to-tool.dto';
import { ConversationEntity } from './entities/conversation.entity';
import { ConversationCleanupTaskEntity } from './entities/conversation-cleanup-task.entity';
import { MessageEntity } from './entities/message.entity';
import { ResourceEntity } from '../resource/entities/resource.entity';
import { ArtifactEntity } from '../artifact/entities/artifact.entity';
import { GeneratedAppEntity } from '../generated-app/entities/generated-app.entity';
import { UserEntity } from '../user/entities/user.entity';
import { execFileNoThrow } from '../../../utils/execFileNoThrow.js';
import {
  findNetworkTranscriptFile,
  getNetworkConversationMemoryDir,
  networkRootDir,
  userDataRootDir,
} from '../../utils/networkTranscriptStorage.js';
import { deleteConversationMemorySession } from '../../memory/conversationMemoryLifecycle.js';
import {
  markConversationMemorySessionDeleting,
  unmarkConversationMemorySessionDeleting,
} from '../../memory/conversationMemoryLock.js';
import type {
  JsonValue,
  SkillOutcome,
} from '../../../skills/skillLifecycleTypes.js';

declare global {
  namespace Express {
    interface Request {
      userId?: number;
    }
  }
}

export interface MessageAction {
  id: string;
  kind: string;
  label: string;
  artifact_id?: string;
  artifactId?: string;
  view_mode?: string;
  viewMode?: string;
}

type MessageMediaKind = 'image' | 'audio' | 'video' | 'html' | 'app' | 'file';

export interface MessageMedia {
  id: string;
  kind: MessageMediaKind;
  url: string;
  title?: string;
  caption?: string;
  alt?: string;
  artifact_id?: string;
  artifactId?: string;
  download_url?: string;
  downloadUrl?: string;
  mime_type?: string;
  mimeType?: string;
  storage_path?: string;
  storagePath?: string;
  size_bytes?: number;
  sizeBytes?: number;
  created_at?: string;
  createdAt?: string;
}

export type MessageBlockType = 'text' | 'status' | 'tool_call' | 'tool_result' | 'skill' | 'artifact' | 'ask_question';

export interface MessageBlock {
  id: string;
  type: MessageBlockType;
  text?: string;
  title?: string;
  name?: string | null;
  status?: string | null;
  toolUseId?: string | null;
  isError?: boolean;
  questions?: AgentAskQuestion[];
  answers?: Record<string, string>;
  media?: MessageMedia[];
  files?: MessageMedia[];
  actions?: MessageAction[];
  raw?: Record<string, unknown> | null;
}

export interface ConversationMessage {
  id: string;
  thread_id: string;
  threadId: string;
  role: 'user' | 'assistant' | 'system';
  kind: string;
  content: string;
  reasoning?: string;
  think?: string;
  agent_id?: string;
  agentId?: string;
  agent_name?: string;
  agentName?: string;
  agent_accent?: string;
  agentAccent?: string;
  actions?: MessageAction[];
  media?: MessageMedia[];
  attachments?: MessageMedia[];
  client_request_id?: string;
  clientRequestId?: string;
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
  created_at: string;
  createdAt: string;
}

export interface UploadedConversationFile {
  asset_id: string;
  assetId: string;
  upload_message_id?: string;
  uploadMessageId?: string;
  kind: MessageMediaKind;
  url: string;
  download_url?: string;
  downloadUrl?: string;
  title: string;
  mime_type: string;
  mimeType: string;
  size_bytes: number;
  sizeBytes: number;
  created_at: string;
  createdAt: string;
  storage_path: string;
  storagePath: string;
  stored_file_name: string;
  storedFileName: string;
  original_name: string;
  originalName: string;
}

export type ConversationStreamEvent =
  | {
      type: 'message.created';
      conversation_id: string;
      conversationId: string;
      message_id: string;
      messageId: string;
      assistant_message_id: string;
      assistantMessageId: string;
      created_at: string;
      createdAt: string;
    }
  | {
      type: 'reasoning.delta';
      message_id: string;
      messageId: string;
      delta: string;
    }
  | {
      type: 'reply.delta';
      message_id: string;
      messageId: string;
      delta: string;
    }
  | {
      type: 'message.block.delta';
      message_id: string;
      messageId: string;
      block_id: string;
      blockId: string;
      block_type: MessageBlockType;
      blockType: MessageBlockType;
      delta?: string;
      block?: MessageBlock;
    }
  | {
      type: 'message.block.completed';
      message_id: string;
      messageId: string;
      block: MessageBlock;
    }
  | {
      type: 'skill.completed';
      message_id: string;
      messageId: string;
      skill_call_id: string;
      skillCallId: string;
      skill_name: string;
      skillName: string;
      outcome: SkillOutcome;
      summary: string;
      result?: JsonValue;
      started_at: string;
      startedAt: string;
      completed_at: string;
      completedAt: string;
      duration_ms: number;
      durationMs: number;
      source: 'agent' | 'harness';
    }
  | {
      type: 'artifact.created';
      message_id: string;
      messageId: string;
      media: MessageMedia[];
      actions?: MessageAction[];
    }
  | {
      type: 'message.completed';
      accepted: boolean;
      status: string;
      conversation_id: string;
      conversationId: string;
      message_id: string;
      messageId: string;
      assistant_message_id: string;
      assistantMessageId: string;
      reply: string;
      reasoning?: string;
      think?: string;
      media?: MessageMedia[];
      actions?: MessageAction[];
      blocks?: MessageBlock[];
      raw?: Record<string, unknown>;
    }
  | {
      type: 'error';
      message: string;
      code?: string;
    };

interface RuntimeJsonlEvent {
  type?: string;
  uuid?: string;
  timestamp?: string;
  promptId?: string;
  sessionId?: string;
  toolUseResult?: unknown;
  message?: {
    id?: string;
    role?: 'user' | 'assistant' | 'system';
    content?: unknown;
    reasoning?: unknown;
    think?: unknown;
    thinking?: unknown;
    actions?: MessageAction[];
  };
}

const conversationFilesRootDir = join(networkRootDir, 'files');
const maxUploadBytes = 20 * 1024 * 1024;
const manifestFileName = '_manifest.json';
const maxInjectedTextChars = 20_000;

type SupportedUploadKind = 'image' | 'video' | 'text';

interface UploadPolicy {
  kind: SupportedUploadKind;
  extension: string;
  allowedMimeTypes: readonly string[];
  maxBytes: number;
}

interface PreparedAttachmentPayload {
  content: string;
  attachmentsForAgent: Array<{
    assetId: string;
    path: string;
    title?: string;
    mimeType?: string;
  }>;
}

interface SkillCreateCommand {
  name: string;
  description: string;
  content: string;
  category: string;
  arguments?: string;
}

type SkillStreamRoute =
  | { kind: 'create'; command: SkillCreateCommand }
  | { kind: 'list' }
  | {
      kind: 'invoke';
      source: 'skill';
      skillName: string;
      args: string;
    };

interface StreamMessageIds {
  userMessageId: string;
  assistantMessageId: string;
}

class SkillProgressQueue implements AsyncIterable<SkillProgressEvent> {
  private values: SkillProgressEvent[] = [];
  private waiting: Array<(value: IteratorResult<SkillProgressEvent>) => void> = [];
  private closed = false;

  push(value: SkillProgressEvent) {
    if (this.closed || !value.delta) {
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
      resolve({ value: undefined as unknown as SkillProgressEvent, done: true });
    }
  }

  private async next(): Promise<IteratorResult<SkillProgressEvent>> {
    const value = this.values.shift();
    if (value) {
      return { value, done: false };
    }
    if (this.closed) {
      return { value: undefined as unknown as SkillProgressEvent, done: true };
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

const uploadPolicies: Record<string, UploadPolicy> = {
  '.png': {
    kind: 'image',
    extension: '.png',
    allowedMimeTypes: ['image/png'],
    maxBytes: maxUploadBytes,
  },
  '.jpg': {
    kind: 'image',
    extension: '.jpg',
    allowedMimeTypes: ['image/jpeg'],
    maxBytes: maxUploadBytes,
  },
  '.jpeg': {
    kind: 'image',
    extension: '.jpeg',
    allowedMimeTypes: ['image/jpeg'],
    maxBytes: maxUploadBytes,
  },
  '.webp': {
    kind: 'image',
    extension: '.webp',
    allowedMimeTypes: ['image/webp'],
    maxBytes: maxUploadBytes,
  },
  '.gif': {
    kind: 'image',
    extension: '.gif',
    allowedMimeTypes: ['image/gif'],
    maxBytes: maxUploadBytes,
  },
  '.mp4': {
    kind: 'video',
    extension: '.mp4',
    allowedMimeTypes: ['video/mp4'],
    maxBytes: maxUploadBytes,
  },
  '.txt': {
    kind: 'text',
    extension: '.txt',
    allowedMimeTypes: ['text/plain'],
    maxBytes: maxUploadBytes,
  },
  '.md': {
    kind: 'text',
    extension: '.md',
    allowedMimeTypes: ['text/markdown', 'text/x-markdown', 'text/plain', 'application/markdown'],
    maxBytes: maxUploadBytes,
  },
  '.pdf': {
    kind: 'text',
    extension: '.pdf',
    allowedMimeTypes: ['application/pdf'],
    maxBytes: maxUploadBytes,
  },
  '.doc': {
    kind: 'text',
    extension: '.doc',
    allowedMimeTypes: ['application/msword'],
    maxBytes: maxUploadBytes,
  },
  '.docx': {
    kind: 'text',
    extension: '.docx',
    allowedMimeTypes: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/zip',
    ],
    maxBytes: maxUploadBytes,
  },
};

const genericUploadMimeTypes = new Set(['application/octet-stream', '']);
const supportedMediaKinds = new Set<MessageMediaKind>([
  'image',
  'audio',
  'video',
  'html',
  'app',
  'file',
]);

@Injectable()
export class ConversationService implements OnModuleInit {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    @InjectRepository(ResourceEntity)
    private readonly messageResourceRepo: Repository<ResourceEntity>,
    @InjectRepository(ConversationCleanupTaskEntity)
    private readonly cleanupTaskRepo: Repository<ConversationCleanupTaskEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    private readonly agentService: AgentService,
    private readonly skillService: SkillService,
    private readonly artifactService: ArtifactService,
    private readonly profileService: ProfileService,
    private readonly transcriptProjection: ConversationTranscriptProjectionService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.retryPendingConversationCleanupTasks();
    } catch (error) {
      console.error('[ConversationService] cleanup task recovery failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async createConversation(dto: CreateConversationDto, requestUserId: number) {
    const now = new Date();
    const userId = requestUserId;
    const agentConversation = await this.agentService.createConversation({
      userId: String(userId),
      title: dto.title,
      preview: dto.preview,
    });

    const conversation = this.conversationRepo.create({
      id: agentConversation.conversationId,
      userId,
      title: agentConversation.title,
      preview: agentConversation.preview,
      status: agentConversation.status,
      createdAt: new Date(agentConversation.createdAt),
      updatedAt: dto.updatedAt ?? new Date(agentConversation.updatedAt),
    });
    const savedConversation = await this.conversationRepo.save(conversation);

    await this.ensureConversationFileManifest(
      savedConversation.userId,
      savedConversation.id,
    );

    return this.toThreadSummary(savedConversation);
  }

  async listConversations(userId: number) {
    const conversations = await this.conversationRepo.find({
      where: { userId },
      order: { updatedAt: 'DESC' },
    });

    return conversations.map((conversation) => this.toThreadSummary(conversation));
  }

  async listMessages(conversationId: string, requestUserId?: number) {
    const conversation = await this.getConversationByIdentifier(conversationId, requestUserId);
    return this.readRuntimeSessionMessages(conversation.id, conversation.userId);
  }

  async deleteConversation(conversationId: string, requestUserId?: number) {
    if (!requestUserId) {
      throw new ForbiddenException('Missing user identity');
    }

    const conversation = await this.getConversationByIdentifier(conversationId, requestUserId);
    const memoryRoot = getNetworkConversationMemoryDir(conversation.userId);
    const now = new Date();
    const cleanupTask = this.cleanupTaskRepo.create({
      id: randomUUID(),
      userId: conversation.userId,
      conversationId: conversation.id,
      status: 'pending',
      attempts: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });

    markConversationMemorySessionDeleting(memoryRoot, conversation.id);
    try {
      await this.agentService.disposeConversationRuntime(
        String(conversation.userId),
        conversation.id,
      );
    } catch (error) {
      unmarkConversationMemorySessionDeleting(memoryRoot, conversation.id);
      throw error;
    }

    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.save(ConversationCleanupTaskEntity, cleanupTask);
        await manager.update(ProfileEvidenceLinkEntity, {
          userId: conversation.userId,
          conversationId: conversation.id,
          status: 'active',
        }, {
          status: 'invalidated',
          invalidatedReason: 'conversation_deleted',
        });
        await manager.delete(MessageEntity, {
          userId: conversation.userId,
          conversationId: conversation.id,
        });
        await manager.delete(ResourceEntity, {
          userId: conversation.userId,
          conversationId: conversation.id,
        });
        await manager.delete(ArtifactEntity, {
          userId: conversation.userId,
          conversationId: conversation.id,
        });
        await manager.delete(GeneratedAppEntity, {
          userId: conversation.userId,
          conversationId: conversation.id,
        });
        await manager.delete(ConversationEntity, {
          cid: conversation.cid,
          userId: conversation.userId,
        });
      });
    } catch (error) {
      unmarkConversationMemorySessionDeleting(memoryRoot, conversation.id);
      this.agentService.restoreConversationRuntimeAfterFailedDeletion(
        String(conversation.userId),
        conversation.id,
      );
      throw error;
    }

    await Promise.all([
      this.cleanupConversationFiles(conversation),
      this.processConversationMemoryCleanupTask(cleanupTask),
    ]);
  }

  async uploadConversationFile(
    conversationId: string,
    file: Express.Multer.File,
    requestUserId?: number,
  ) {
    const conversation = await this.getConversationByIdentifier(conversationId, requestUserId);

    if (!file) {
      throw new BadRequestException('file is required');
    }

    if (file.size > maxUploadBytes) {
      throw new BadRequestException('file is too large');
    }
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const originalName = file.originalname;
    const mimeType = (file.mimetype || 'application/octet-stream').toLowerCase();
    const validation = this.validateUpload(file, originalName, mimeType);
    const extension = validation.policy.extension;
    const storedFileName = `${Date.now()}-${randomUUID()}${extension}`;
    const conversationDir = this.getConversationFilesDirectory(
      conversation.userId,
      conversation.id,
    );
    const absolutePath = join(conversationDir, storedFileName);
    const relativePath = this.toLocalFilePath(conversation.id, storedFileName, conversation.userId);
    const url = this.toPublicFilePath(conversation.id, storedFileName);
    const createdAt = new Date().toISOString();

    await mkdir(conversationDir, { recursive: true });
    await writeFile(absolutePath, file.buffer);

    const fileStats = await stat(absolutePath);
    const assetId = `asset-${randomUUID()}`;
    const uploadMessageId = `msg_upload_${randomUUID()}`;
    const uploadedFile: UploadedConversationFile = {
      asset_id: assetId,
      assetId,
      upload_message_id: uploadMessageId,
      uploadMessageId,
      kind: this.resolveAssetKind(validation.policy.kind),
      url: url,
      title: file.originalname,
      mime_type: mimeType,
      mimeType,
      size_bytes: fileStats.size,
      sizeBytes: fileStats.size,
      created_at: createdAt,
      createdAt,
      storage_path: relativePath,
      storagePath: relativePath,
      stored_file_name: storedFileName,
      storedFileName: storedFileName,
      original_name: originalName,
      originalName: originalName,
    };

    const manifest = await this.readConversationFileManifest(
      conversation.userId,
      conversation.id,
    );
    manifest.push(uploadedFile);
    await this.writeConversationFileManifest(
      conversation.userId,
      conversation.id,
      manifest,
    );
    await this.persistUploadedFileRecords(conversation, uploadedFile);
    await this.touchConversation(conversation, `Uploaded file: ${originalName}`);

    return this.toPublicUploadedConversationFile(
      this.withConversationFileDownloadUrl(
        uploadedFile,
        conversation.userId,
        conversation.id,
      ),
    );
  }

  async getConversationFile(conversationId: string, fileName: string, requestUserId?: number) {
    const conversation = await this.getConversationByIdentifier(conversationId, requestUserId);
    const manifest = await this.readConversationFileManifest(
      conversation.userId,
      conversation.id,
    );
    const asset = manifest.find(
      (entry) =>
        entry.stored_file_name === fileName || entry.storedFileName === fileName,
    );

    if (!asset) {
      throw new NotFoundException(`File ${fileName} not found`);
    }

    return {
      asset,
      absolutePath: join(
        this.getConversationFilesDirectory(conversation.userId, conversation.id),
        fileName,
      ),
    };
  }

  async sendMessage(conversationId: string, dto: SendMultimodalMessageDto, requestUserId?: number) {
    const conversation = await this.getConversationByIdentifier(conversationId, requestUserId);
    const attachmentIds = dto.attachment_asset_ids ?? dto.attachmentAssetIds ?? [];
    let attachments = await this.resolveAttachments(conversation.id, attachmentIds);
    if (attachments.length === 0) {
      attachments = await this.resolveImplicitAttachments(conversation, dto.content);
    }

    const skillInvocation = this.skillService.parseSkillInvocation(dto.content);
    if (skillInvocation && skillInvocation.skillName === 'skills') {
      const skills = await this.skillService.listSkills(conversation.userId);
      const byCategory = new Map<string, typeof skills>();
      for (const s of skills) {
        const cat = (s.category as string | undefined) ?? 'utility';
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat)!.push(s);
      }

      const sections: string[] = ['**Available Skills**\n'];
      const categoryLabels: Record<string, string> = {
        search: '🔍 Search',
        analysis: '🔬 Analysis',
        generation: '🎨 Generation',
        utility: '🛠 Utility',
      };

      for (const [cat, items] of byCategory) {
        const label = categoryLabels[cat] ?? cat;
        sections.push(`**${label}**`);
        for (const s of items) {
          const params = s.parameters as Array<{ name: string }> | undefined;
          const paramHint = params?.length
            ? ` — params: ${params.map((p) => p.name).join(', ')}`
            : '';
          sections.push(`- \`/${s.name}\` — ${s.description}${paramHint}`);
        }
        sections.push('');
      }

      sections.push('Type `/help` for usage information.');
      const reply = sections.join('\n');

      const userMessageId = `msg_user_skill_${randomUUID()}`;
      const assistantMessageId = `msg_assistant_skill_${randomUUID()}`;
      const now = new Date();
      const sessionFilePath = await this.findOrCreateRuntimeSessionFile(conversation.id, conversation.userId);

      await appendFile(
        sessionFilePath,
        `${JSON.stringify({ type: 'user', message: { id: userMessageId, role: 'user', content: dto.content }, uuid: randomUUID(), timestamp: now.toISOString(), sessionId: conversation.id })}\n`,
        'utf8',
      );
      await appendFile(
        sessionFilePath,
        `${JSON.stringify({ type: 'assistant', message: { id: assistantMessageId, role: 'assistant', content: this.createAssistantContentBlocks(reply) }, uuid: randomUUID(), timestamp: new Date(now.getTime() + 100).toISOString(), sessionId: conversation.id })}\n`,
        'utf8',
      );
      await this.linkUploadedResourcesToMessage(
        conversation.userId,
        conversation.id,
        userMessageId,
        attachments,
      );
      await this.touchConversation(conversation, dto.content);

      return {
        accepted: true,
        status: 'done',
        conversation_id: conversation.id,
        conversationId: conversation.id,
        message_id: userMessageId,
        messageId: userMessageId,
        assistant_message_id: assistantMessageId,
        assistantMessageId: assistantMessageId,
        reply,
        blocks: this.createBlocksFromReplyAndArtifacts(reply),
        raw: { source: 'skill-list', skillCount: skills.length },
      };
    }

    const preparedAttachments = await this.prepareAttachmentsForModel(
      conversation,
      dto.content,
      attachments,
    );

    const agentResponse = await this.agentService.sendMessage({
      conversationId: conversation.id,
      userId: String(conversation.userId),
      content: preparedAttachments.content,
      userVisibleContent: dto.content,
      kind: dto.kind,
      attachments: preparedAttachments.attachmentsForAgent,
      context: dto.context,
      clientRequestId: dto.client_request_id ?? dto.clientRequestId,
      apiKey: undefined,
      baseUrl: undefined,
      model: undefined,
    });

    await this.linkUploadedResourcesToMessage(
      conversation.userId,
      conversation.id,
      agentResponse.userMessageId,
      attachments,
    );

    const replyFiles = this.normalizeReplyFiles(agentResponse.file);
    const toolGeneratedMedia = agentResponse.generatedFiles?.length
      ? await this.skillOutputFilesToMedia(agentResponse.generatedFiles, conversation.userId)
      : [];
    const assistantResources = [...replyFiles, ...toolGeneratedMedia];
    const persistedAssistantResources = await this.persistAssistantGeneratedResources(
      conversation.userId,
      conversation.id,
      agentResponse.assistantMessageId,
      assistantResources,
    );
    const sessionFilePath = await this.findOrCreateRuntimeSessionFile(conversation.id, conversation.userId);
    if (persistedAssistantResources.media.length) {
      await this.replaceMessageResourceMappings(
        conversation.userId,
        conversation.id,
        agentResponse.assistantMessageId,
        persistedAssistantResources.media,
      );
    }
    await this.mergeAssistantMessageActions(
      sessionFilePath,
      agentResponse.assistantMessageId,
      persistedAssistantResources.actions,
    );
    await this.touchConversation(conversation, dto.content);
    await this.saveProfileSuggestionsFromAgentOutput(
      conversation.userId,
      conversation.id,
      {
        reply: agentResponse.reply,
        reasoning: agentResponse.reasoning,
        raw: agentResponse.raw,
      },
    );

    return {
      accepted: agentResponse.accepted,
      status: agentResponse.status,
      conversation_id: agentResponse.conversationId,
      conversationId: agentResponse.conversationId,
      message_id: agentResponse.userMessageId,
      messageId: agentResponse.userMessageId,
      assistant_message_id: agentResponse.assistantMessageId,
      assistantMessageId: agentResponse.assistantMessageId,
      reply: sanitizeServerPhysicalPaths(agentResponse.reply),
      reasoning: agentResponse.reasoning
        ? sanitizeServerPhysicalPaths(agentResponse.reasoning)
        : undefined,
      think: agentResponse.reasoning
        ? sanitizeServerPhysicalPaths(agentResponse.reasoning)
        : undefined,
      media: persistedAssistantResources.media,
      actions: persistedAssistantResources.actions,
      blocks: normalizeCanonicalMessageBlocks(
        this.appendArtifactBlockToMessageBlocks(
          (agentResponse.blocks ?? []) as MessageBlock[],
          persistedAssistantResources.media,
          persistedAssistantResources.actions,
        ),
        { authoritativeText: agentResponse.reply },
      ) as MessageBlock[] | undefined,
      raw: sanitizeServerPhysicalPathsInValue(agentResponse.raw),
    };
  }

  async respondToInteractiveTool(
    conversationId: string,
    toolUseId: string,
    dto: RespondToToolDto,
    requestUserId?: number,
  ) {
    const conversation = await this.getConversationByIdentifier(conversationId, requestUserId);
    const accepted = await this.agentService.respondToInteractiveTool(
      conversation.id,
      String(conversation.userId),
      toolUseId,
      {
        approved: dto.approved,
        answers: this.normalizeToolAnswers(dto.answers),
        annotations: this.normalizeToolAnnotations(dto.annotations),
      },
    );

    if (!accepted) {
      throw new NotFoundException('This question is no longer waiting for a response');
    }

    return { accepted: true };
  }

  async *sendMessageStream(
    conversationId: string,
    dto: SendMultimodalMessageDto,
    requestUserId?: number,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<ConversationStreamEvent> {
    const conversation = await this.getConversationByIdentifier(conversationId, requestUserId);
    const attachmentIds = dto.attachment_asset_ids ?? dto.attachmentAssetIds ?? [];
    let attachments = await this.resolveAttachments(conversation.id, attachmentIds);
    if (attachments.length === 0) {
      attachments = await this.resolveImplicitAttachments(conversation, dto.content);
    }

    const skillStreamRoute = await this.resolveSkillStreamRoute(conversation, dto);
    if (skillStreamRoute) {
      yield* this.streamSkillMessage(
        conversation,
        dto,
        attachments,
        skillStreamRoute,
        abortSignal,
      );
      return;
    }

    const preparedAttachments = await this.prepareAttachmentsForModel(
      conversation,
      dto.content,
      attachments,
    );

    let userMessageId = '';
    let assistantMessageId = '';

    for await (const event of this.agentService.sendMessageStream({
      conversationId: conversation.id,
      userId: String(conversation.userId),
      content: preparedAttachments.content,
      userVisibleContent: dto.content,
      kind: dto.kind,
      attachments: preparedAttachments.attachmentsForAgent,
      context: dto.context,
      clientRequestId: dto.client_request_id ?? dto.clientRequestId,
      abortSignal,
      apiKey: undefined,
      baseUrl: undefined,
      model: undefined,
    })) {
      if (event.type === 'message.created') {
        userMessageId = event.userMessageId;
        assistantMessageId = event.assistantMessageId;
        await this.linkUploadedResourcesToMessage(
          conversation.userId,
          conversation.id,
          userMessageId,
          attachments,
        );
        yield {
          type: 'message.created',
          conversation_id: event.conversationId,
          conversationId: event.conversationId,
          message_id: event.userMessageId,
          messageId: event.userMessageId,
          assistant_message_id: event.assistantMessageId,
          assistantMessageId: event.assistantMessageId,
          created_at: event.createdAt,
          createdAt: event.createdAt,
        };
        continue;
      }

      if (event.type === 'reasoning.delta') {
        yield {
          type: 'reasoning.delta',
          message_id: event.messageId,
          messageId: event.messageId,
          delta: event.delta,
        };
        continue;
      }

      if (event.type === 'reply.delta') {
        yield {
          type: 'reply.delta',
          message_id: event.messageId,
          messageId: event.messageId,
          delta: event.delta,
        };
        continue;
      }

      if (event.type === 'message.block.delta') {
        yield {
          type: 'message.block.delta',
          message_id: event.messageId,
          messageId: event.messageId,
          block_id: event.blockId,
          blockId: event.blockId,
          block_type: event.blockType,
          blockType: event.blockType,
          delta: event.delta ? sanitizeServerPhysicalPaths(event.delta) : undefined,
          block: event.block
            ? sanitizeServerPhysicalPathsInValue(event.block) as MessageBlock
            : undefined,
        };
        continue;
      }

      if (event.type === 'message.block.completed') {
        yield {
          type: 'message.block.completed',
          message_id: event.messageId,
          messageId: event.messageId,
          block: sanitizeServerPhysicalPathsInValue(event.block) as MessageBlock,
        };
        continue;
      }

      if (event.type === 'skill.completed') {
        yield {
          type: 'skill.completed',
          message_id: event.messageId,
          messageId: event.messageId,
          skill_call_id: event.skillCallId,
          skillCallId: event.skillCallId,
          skill_name: event.skillName,
          skillName: event.skillName,
          outcome: event.outcome,
          summary: sanitizeServerPhysicalPaths(event.summary),
          result: sanitizeServerPhysicalPathsInValue(event.result) as JsonValue | undefined,
          started_at: event.startedAt,
          startedAt: event.startedAt,
          completed_at: event.completedAt,
          completedAt: event.completedAt,
          duration_ms: event.durationMs,
          durationMs: event.durationMs,
          source: event.source,
        };
        continue;
      }

      if (event.type === 'error') {
        yield {
          type: 'error',
          message: event.message,
          code: event.code,
        };
        continue;
      }

      if (event.type === 'message.completed') {
        userMessageId = event.userMessageId || userMessageId;
        assistantMessageId = event.assistantMessageId || assistantMessageId;
        const replyFiles = this.normalizeReplyFiles(event.file);
        const toolGeneratedMedia = event.generatedFiles?.length
          ? await this.skillOutputFilesToMedia(event.generatedFiles, conversation.userId)
          : [];
        const assistantResources = [...replyFiles, ...toolGeneratedMedia];
        const persistedAssistantResources = await this.persistAssistantGeneratedResources(
          conversation.userId,
          conversation.id,
          assistantMessageId,
          assistantResources,
        );
        const sessionFilePath = await this.findOrCreateRuntimeSessionFile(conversation.id, conversation.userId);

        if (persistedAssistantResources.media.length) {
          await this.replaceMessageResourceMappings(
            conversation.userId,
            conversation.id,
            assistantMessageId,
            persistedAssistantResources.media,
          );
          yield {
            type: 'artifact.created',
            message_id: assistantMessageId,
            messageId: assistantMessageId,
            media: persistedAssistantResources.media,
            actions: persistedAssistantResources.actions,
          };
        }

        await this.mergeAssistantMessageActions(
          sessionFilePath,
          assistantMessageId,
          persistedAssistantResources.actions,
        );
        await this.touchConversation(conversation, dto.content);
        await this.saveProfileSuggestionsFromAgentOutput(
          conversation.userId,
          conversation.id,
          {
            reply: event.reply,
            reasoning: event.reasoning,
            raw: event.raw,
          },
        );

        const completedBlocksSource = event.blocks
          ? this.appendArtifactBlockToMessageBlocks(
              event.blocks as MessageBlock[],
              persistedAssistantResources.media,
              persistedAssistantResources.actions,
            )
          : this.createBlocksFromReplyAndArtifacts(
              event.reply,
              undefined,
              persistedAssistantResources.media,
              persistedAssistantResources.actions,
            );
        const completedBlocks = normalizeCanonicalMessageBlocks(completedBlocksSource, {
          authoritativeText: event.reply,
        }) as MessageBlock[] | undefined;

        yield {
          type: 'message.completed',
          accepted: event.accepted,
          status: event.status,
          conversation_id: event.conversationId,
          conversationId: event.conversationId,
          message_id: userMessageId,
          messageId: userMessageId,
          assistant_message_id: assistantMessageId,
          assistantMessageId: assistantMessageId,
          reply: sanitizeServerPhysicalPaths(event.reply),
          reasoning: event.reasoning
            ? sanitizeServerPhysicalPaths(event.reasoning)
            : undefined,
          think: event.reasoning
            ? sanitizeServerPhysicalPaths(event.reasoning)
            : undefined,
          media: persistedAssistantResources.media.length ? persistedAssistantResources.media : undefined,
          actions: persistedAssistantResources.actions.length ? persistedAssistantResources.actions : undefined,
          blocks: sanitizeServerPhysicalPathsInValue(completedBlocks) as MessageBlock[] | undefined,
          raw: sanitizeServerPhysicalPathsInValue(event.raw),
        };
      }
    }
  }

  private resolveSkillStreamRoute(
    _conversation: ConversationEntity,
    dto: SendMultimodalMessageDto,
  ): SkillStreamRoute | null {
    const skillInvocation = this.skillService.parseSkillInvocation(dto.content);
    if (skillInvocation?.skillName === 'skills') {
      return { kind: 'list' };
    }

    return null;
  }

  private async *streamSkillMessage(
    conversation: ConversationEntity,
    dto: SendMultimodalMessageDto,
    attachments: MessageMedia[],
    route: SkillStreamRoute,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<ConversationStreamEvent> {
    if (route.kind === 'create') {
      yield* this.streamCreateSkillMessage(conversation, dto, attachments, route.command);
      return;
    }

    if (route.kind === 'list') {
      yield* this.streamSkillListMessage(conversation, dto, attachments);
      return;
    }

    yield* this.streamInvokedSkillMessage(
      conversation,
      dto,
      attachments,
      route,
      abortSignal,
    );
  }

  private async *streamCreateSkillMessage(
    conversation: ConversationEntity,
    dto: SendMultimodalMessageDto,
    attachments: MessageMedia[],
    command: SkillCreateCommand,
  ): AsyncGenerator<ConversationStreamEvent> {
    const ids = this.createStreamMessageIds('skill_create');
    const now = new Date();
    const sessionFilePath = await this.findOrCreateRuntimeSessionFile(conversation.id, conversation.userId);
    const processTrace = `Creating skill /${command.name}.`;

    await this.appendRuntimeUserMessage(sessionFilePath, conversation.id, ids.userMessageId, dto.content, now);
    await this.linkUploadedResourcesToMessage(conversation.userId, conversation.id, ids.userMessageId, attachments);

    yield this.createMessageCreatedStreamEvent(conversation.id, ids, now.toISOString());
    yield this.createBlockCompletedStreamEvent(
      ids.assistantMessageId,
      this.createStatusMessageBlock('status-0', processTrace),
    );
    yield* this.streamReasoningDeltaEvents(ids.assistantMessageId, `${processTrace}\n`);

    const created = await this.skillService.createCustomSkill(
      conversation.userId,
      command.name,
      command.description,
      command.content,
      command.category,
      command.arguments,
    );

    const reply =
      `Skill \`/${created.name}\` created successfully.\n\n` +
      `You can now invoke it with \`/${created.name}\`.`;

    await this.appendRuntimeAssistantMessage(
      sessionFilePath,
      conversation.id,
      ids.assistantMessageId,
      this.createAssistantContentBlocks(reply, processTrace),
      new Date(now.getTime() + 500),
    );
    yield* this.streamTextBlockDeltaEvents(ids.assistantMessageId, reply);

    await this.touchConversation(conversation, dto.content);

    yield this.createMessageCompletedStreamEvent(conversation.id, ids, reply, {
      reasoning: processTrace,
      raw: { source: 'skill:create', skillName: created.name },
    });
  }

  private async *streamSkillListMessage(
    conversation: ConversationEntity,
    dto: SendMultimodalMessageDto,
    attachments: MessageMedia[],
  ): AsyncGenerator<ConversationStreamEvent> {
    const ids = this.createStreamMessageIds('skill_list');
    const now = new Date();
    const sessionFilePath = await this.findOrCreateRuntimeSessionFile(conversation.id, conversation.userId);
    const processTrace = 'Listing available skills.';

    await this.appendRuntimeUserMessage(sessionFilePath, conversation.id, ids.userMessageId, dto.content, now);
    await this.linkUploadedResourcesToMessage(conversation.userId, conversation.id, ids.userMessageId, attachments);

    yield this.createMessageCreatedStreamEvent(conversation.id, ids, now.toISOString());
    yield this.createBlockCompletedStreamEvent(
      ids.assistantMessageId,
      this.createStatusMessageBlock('status-0', processTrace),
    );
    yield* this.streamReasoningDeltaEvents(ids.assistantMessageId, `${processTrace}\n`);

    const skills = await this.skillService.listSkills(conversation.userId);
    const reply = this.formatSkillListReply(skills);

    await this.appendRuntimeAssistantMessage(
      sessionFilePath,
      conversation.id,
      ids.assistantMessageId,
      this.createAssistantContentBlocks(reply, processTrace),
      new Date(now.getTime() + 500),
    );
    yield* this.streamTextBlockDeltaEvents(ids.assistantMessageId, reply);

    await this.touchConversation(conversation, dto.content);

    yield this.createMessageCompletedStreamEvent(conversation.id, ids, reply, {
      reasoning: processTrace,
      raw: { source: 'skill-list', skillCount: skills.length },
    });
  }

  private async *streamInvokedSkillMessage(
    conversation: ConversationEntity,
    dto: SendMultimodalMessageDto,
    attachments: MessageMedia[],
    route: Extract<SkillStreamRoute, { kind: 'invoke' }>,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<ConversationStreamEvent> {
    const ids = this.createStreamMessageIds('skill');
    const now = new Date();
    const sessionFilePath = await this.findOrCreateRuntimeSessionFile(conversation.id, conversation.userId);

    await this.appendRuntimeUserMessage(sessionFilePath, conversation.id, ids.userMessageId, dto.content, now);
    await this.linkUploadedResourcesToMessage(conversation.userId, conversation.id, ids.userMessageId, attachments);

    yield this.createMessageCreatedStreamEvent(conversation.id, ids, now.toISOString());
    yield this.createBlockCompletedStreamEvent(
      ids.assistantMessageId,
      createSkillLoadedBlock<MessageBlock>(route.skillName),
    );

    const skillContext = await this.skillService.buildExecutionContext(
      conversation.userId,
      conversation.id,
    );
    const progressQueue = new SkillProgressQueue();
    const skillOutcomePromise = this.skillService.invokeSkill(
      route.skillName,
      route.args,
      {
        ...dto.context,
        ...skillContext,
        abortSignal,
        onProgress: (event: SkillProgressEvent) => progressQueue.push(event),
      },
    ).then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error }),
    ).finally(() => progressQueue.close());

    for await (const progress of progressQueue) {
      if (abortSignal?.aborted) {
        continue;
      }

      const delta = sanitizeServerPhysicalPaths(progress.delta);
      if (!delta) {
        continue;
      }
    }

    const skillOutcome = await skillOutcomePromise;
    if (skillOutcome.error) {
      throw skillOutcome.error;
    }
    if (!skillOutcome.result || abortSignal?.aborted) {
      return;
    }

    const skillResult = skillOutcome.result;
    const presentation = this.buildSkillReplyPresentation(skillResult, route.skillName);

    await this.appendRuntimeAssistantMessage(
      sessionFilePath,
      conversation.id,
      ids.assistantMessageId,
      presentation.assistantContentBlocks,
      new Date(now.getTime() + 500),
    );

    const persisted = await this.persistSkillOutputFilesForStream(
      conversation.userId,
      conversation.id,
      ids.assistantMessageId,
      sessionFilePath,
      skillResult,
    );

    if (persisted.media.length) {
      yield {
        type: 'artifact.created',
        message_id: ids.assistantMessageId,
        messageId: ids.assistantMessageId,
        media: persisted.media,
        actions: persisted.actions,
      };
    }

    yield* this.streamTextBlockDeltaEvents(ids.assistantMessageId, presentation.visibleReply);

    await this.touchConversation(conversation, dto.content);

    yield this.createMessageCompletedStreamEvent(conversation.id, ids, presentation.visibleReply, {
      media: persisted.media.length ? persisted.media : undefined,
      actions: persisted.actions.length ? persisted.actions : undefined,
      blocks: this.appendArtifactBlockToMessageBlocks(
        presentation.messageBlocks,
        persisted.media,
        persisted.actions,
      ),
      raw: {
        source: route.source,
        skillName: route.skillName,
        ...skillResult.metadata,
      },
    });
  }

  private createStreamMessageIds(prefix: string): StreamMessageIds {
    const suffix = randomUUID().replace(/-/g, '');
    return {
      userMessageId: `msg_user_${prefix}_${suffix}`,
      assistantMessageId: `msg_assistant_${prefix}_${suffix}`,
    };
  }

  private async saveProfileSuggestionsFromAgentOutput(
    userId: number,
    sourceThreadId: string,
    output: unknown,
  ) {
    try {
      await this.profileService.saveSuggestionsFromOutput({
        userId,
        sourceThreadId,
        output,
      });
    } catch (error: unknown) {
      skillLogger.warn(
        'ConversationService',
        'Profile suggestion extraction failed',
        {
          userId,
          conversationId: sourceThreadId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  private async appendRuntimeUserMessage(
    sessionFilePath: string,
    conversationId: string,
    messageId: string,
    content: string,
    timestamp: Date,
  ) {
    await appendFile(
      sessionFilePath,
      `${JSON.stringify({
        type: 'user',
        message: { id: messageId, role: 'user', content },
        uuid: randomUUID(),
        timestamp: timestamp.toISOString(),
        sessionId: conversationId,
      })}\n`,
      'utf8',
    );
  }

  private async appendRuntimeAssistantMessage(
    sessionFilePath: string,
    conversationId: string,
    messageId: string,
    content: Array<Record<string, unknown>>,
    timestamp: Date,
  ) {
    await appendFile(
      sessionFilePath,
      `${JSON.stringify({
        type: 'assistant',
        message: { id: messageId, role: 'assistant', content },
        uuid: randomUUID(),
        timestamp: timestamp.toISOString(),
        sessionId: conversationId,
      })}\n`,
      'utf8',
    );
  }

  private createMessageCreatedStreamEvent(
    conversationId: string,
    ids: StreamMessageIds,
    createdAt: string,
  ): ConversationStreamEvent {
    return {
      type: 'message.created',
      conversation_id: conversationId,
      conversationId,
      message_id: ids.userMessageId,
      messageId: ids.userMessageId,
      assistant_message_id: ids.assistantMessageId,
      assistantMessageId: ids.assistantMessageId,
      created_at: createdAt,
      createdAt,
    };
  }

  private createMessageCompletedStreamEvent(
    conversationId: string,
    ids: StreamMessageIds,
    reply: string,
    options: {
      reasoning?: string;
      media?: MessageMedia[];
      actions?: MessageAction[];
      blocks?: MessageBlock[];
      raw?: Record<string, unknown>;
    } = {},
  ): ConversationStreamEvent {
    const sourceBlocks = options.blocks ?? this.createBlocksFromReplyAndArtifacts(
      reply,
      options.reasoning,
      options.media,
      options.actions,
    );
    const blocks = normalizeCanonicalMessageBlocks(sourceBlocks, {
      authoritativeText: reply,
    }) as MessageBlock[] | undefined;

    return {
      type: 'message.completed',
      accepted: true,
      status: 'done',
      conversation_id: conversationId,
      conversationId,
      message_id: ids.userMessageId,
      messageId: ids.userMessageId,
      assistant_message_id: ids.assistantMessageId,
      assistantMessageId: ids.assistantMessageId,
      reply: sanitizeServerPhysicalPaths(reply),
      reasoning: options.reasoning
        ? sanitizeServerPhysicalPaths(options.reasoning)
        : undefined,
      think: options.reasoning
        ? sanitizeServerPhysicalPaths(options.reasoning)
        : undefined,
      media: options.media,
      actions: options.actions,
      blocks,
      raw: sanitizeServerPhysicalPathsInValue(options.raw),
    };
  }

  private createBlocksFromReplyAndArtifacts(
    reply: string,
    statusText?: string,
    media: MessageMedia[] = [],
    actions: MessageAction[] = [],
  ): MessageBlock[] {
    const blocks: MessageBlock[] = [];
    const sanitizedStatus = statusText ? sanitizeServerPhysicalPaths(statusText).trim() : '';
    const sanitizedReply = sanitizeServerPhysicalPaths(reply).trim();

    if (sanitizedStatus) {
      blocks.push({
        id: 'status-0',
        type: 'status',
        title: THINKING_BLOCK_TITLE,
        text: sanitizedStatus,
      });
    }

    if (sanitizedReply) {
      blocks.push({
        id: 'text-0',
        type: 'text',
        text: sanitizedReply,
      });
    }

    return this.appendArtifactBlockToMessageBlocks(blocks, media, actions);
  }

  private appendArtifactBlockToMessageBlocks(
    blocks: MessageBlock[],
    media: MessageMedia[] = [],
    actions: MessageAction[] = [],
  ): MessageBlock[] {
    const nextBlocks = [...(blocks ?? [])];
    if (!media.length && !actions.length) {
      return nextBlocks;
    }

    const existingArtifactIndex = nextBlocks.findIndex((block) => block.type === 'artifact');
    const artifactBlock: MessageBlock = {
      id: 'artifact-0',
      type: 'artifact',
      title: '生成内容',
      text: media.length ? '已生成可打开的内容。' : undefined,
      media,
      actions,
    };

    if (existingArtifactIndex >= 0) {
      nextBlocks[existingArtifactIndex] = {
        ...nextBlocks[existingArtifactIndex],
        media: [
          ...(nextBlocks[existingArtifactIndex].media ?? []),
          ...media,
        ],
        actions: this.mergeMessageActions(
          nextBlocks[existingArtifactIndex].actions,
          actions,
        ),
      };
      return nextBlocks;
    }

    nextBlocks.push(artifactBlock);
    return nextBlocks;
  }

  private createBlockCompletedStreamEvent(
    messageId: string,
    block: MessageBlock,
  ): ConversationStreamEvent {
    return {
      type: 'message.block.completed',
      message_id: messageId,
      messageId,
      block: sanitizeServerPhysicalPathsInValue(block) as MessageBlock,
    };
  }

  private createStatusMessageBlock(id: string, text: string): MessageBlock {
    return {
      id,
      type: 'status',
      title: THINKING_BLOCK_TITLE,
      text: sanitizeServerPhysicalPaths(text),
    };
  }

  private createSkillMessageBlock(
    skillName: string,
    status: string,
    text?: string,
  ): MessageBlock {
    return {
      id: `skill-${skillName}`,
      type: 'skill',
      title: `Skill · /${skillName}`,
      name: skillName,
      status,
      text: text ? sanitizeServerPhysicalPaths(text) : undefined,
    };
  }

  private *streamTextBlockDeltaEvents(
    messageId: string,
    text?: string,
    blockId = 'text-0',
  ): Generator<ConversationStreamEvent> {
    for (const delta of this.chunkStreamText(text)) {
      yield {
        type: 'message.block.delta',
        message_id: messageId,
        messageId,
        block_id: blockId,
        blockId,
        block_type: 'text',
        blockType: 'text',
        delta,
        block: {
          id: blockId,
          type: 'text',
          text: '',
        },
      };
    }
  }

  private *streamReasoningDeltaEvents(
    messageId: string,
    text?: string,
  ): Generator<ConversationStreamEvent> {
    for (const delta of this.chunkStreamText(text)) {
      yield {
        type: 'reasoning.delta',
        message_id: messageId,
        messageId,
        delta,
      };
    }
  }

  private chunkStreamText(text?: string, chunkSize = 700): string[] {
    if (!text) {
      return [];
    }

    const publicText = sanitizeServerPhysicalPaths(text);
    const chunks: string[] = [];
    for (let start = 0; start < publicText.length; start += chunkSize) {
      chunks.push(publicText.slice(start, start + chunkSize));
    }
    return chunks;
  }

  private formatSkillRouteTrace(route: Extract<SkillStreamRoute, { kind: 'invoke' }>) {
    return `Skill command selected: /${route.skillName}.`;
  }

  private formatSkillListReply(skills: Awaited<ReturnType<SkillService['listSkills']>>) {
    const byCategory = new Map<string, typeof skills>();
    for (const skill of skills) {
      const category = (skill.category as string | undefined) ?? 'utility';
      if (!byCategory.has(category)) {
        byCategory.set(category, []);
      }
      byCategory.get(category)!.push(skill);
    }

    const sections: string[] = ['**Available Skills**\n'];
    const categoryLabels: Record<string, string> = {
      search: 'Search',
      analysis: 'Analysis',
      generation: 'Generation',
      utility: 'Utility',
    };

    for (const [category, items] of byCategory) {
      sections.push(`**${categoryLabels[category] ?? category}**`);
      for (const skill of items) {
        const params = skill.parameters as Array<{ name: string }> | undefined;
        const paramHint = params?.length
          ? ` - params: ${params.map((param) => param.name).join(', ')}`
          : '';
        sections.push(`- \`/${skill.name}\` - ${skill.description}${paramHint}`);
      }
      sections.push('');
    }

    sections.push('Type `/help` for usage information.');
    return sections.join('\n');
  }

  private buildSkillReplyPresentation(
    skillResult: SkillHandlerResult,
    skillName: string,
  ) {
    const hasOutputFiles = Boolean(skillResult.outputFiles?.length);
    const visibleReply = sanitizeServerPhysicalPaths(hasOutputFiles
      ? (skillResult.outputFiles![0].title ?? 'Application generated. Use the open action to view it.')
      : skillResult.reply);

    return {
      visibleReply,
      messageBlocks: this.createBlocksFromReplyAndArtifacts(
        visibleReply,
        `Skill ${skillName} loaded`,
      ),
      assistantContentBlocks: this.createAssistantContentBlocks(
        visibleReply,
        `Skill ${skillName} loaded`,
      ),
    };
  }

  private createAssistantContentBlocks(reply: string, processTrace?: string) {
    const assistantContentBlocks: Array<Record<string, unknown>> = [];
    if (processTrace) {
      assistantContentBlocks.push({
        type: 'thinking',
        phase: 'process',
        thinking: sanitizeServerPhysicalPaths(processTrace),
        signature: '',
      });
    }
    assistantContentBlocks.push({
      type: 'text',
      phase: 'final',
      text: sanitizeServerPhysicalPaths(reply),
    });
    return assistantContentBlocks;
  }

  private async persistSkillOutputFilesForStream(
    userId: number,
    conversationId: string,
    assistantMessageId: string,
    sessionFilePath: string,
    skillResult: SkillHandlerResult,
  ): Promise<{ media: MessageMedia[]; actions: MessageAction[] }> {
    if (!skillResult.outputFiles?.length) {
      return { media: [], actions: [] };
    }

    skillLogger.info('ConversationService', 'Skill outputFiles:', skillResult.outputFiles);
    const media = await this.skillOutputFilesToMedia(skillResult.outputFiles, userId);
    skillLogger.info('ConversationService', 'Mapped media:', media.map((item) => ({
      id: item.id,
      kind: item.kind,
      url: item.url,
    })));
    const persisted = await this.persistAssistantGeneratedResources(
      userId,
      conversationId,
      assistantMessageId,
      media,
    );
    await this.replaceMessageResourceMappings(userId, conversationId, assistantMessageId, persisted.media);
    await this.mergeAssistantMessageActions(sessionFilePath, assistantMessageId, persisted.actions);

    return persisted;
  }

  private async getConversationByIdentifier(identifier: string, requestUserId?: number) {
    const byAgentId = await this.conversationRepo.findOne({ where: { id: identifier } });
    if (byAgentId) {
      if (requestUserId !== undefined && byAgentId.userId !== requestUserId) {
        throw new ForbiddenException('You do not have access to this conversation');
      }
      return byAgentId;
    }

    const numericId = Number(identifier);
    if (Number.isInteger(numericId)) {
      const byCid = await this.conversationRepo.findOne({ where: { cid: numericId } });
      if (byCid) {
        if (requestUserId !== undefined && byCid.userId !== requestUserId) {
          throw new ForbiddenException('You do not have access to this conversation');
        }
        return byCid;
      }
    }

    throw new NotFoundException(`Conversation ${identifier} not found`);
  }

  private normalizeToolAnswers(value: unknown): Record<string, string> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    const answers = Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string')
      .slice(0, 4)
      .map(([question, answer]) => [question.trim().slice(0, 4_000), answer.trim().slice(0, 4_000)] as const)
      .filter(([question, answer]) => Boolean(question && answer));

    return answers.length ? Object.fromEntries(answers) : undefined;
  }

  private normalizeToolAnnotations(
    value: unknown,
  ): Record<string, { preview?: string; notes?: string }> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    const annotations: Array<[string, { preview?: string; notes?: string }]> = [];
    for (const [question, annotation] of Object.entries(value).slice(0, 4)) {
      if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) {
        continue;
      }
      const record = annotation as Record<string, unknown>;
      const preview = typeof record.preview === 'string' ? record.preview.trim().slice(0, 20_000) : undefined;
      const notes = typeof record.notes === 'string' ? record.notes.trim().slice(0, 4_000) : undefined;
      if (question.trim() && (preview || notes)) {
        annotations.push([question.trim().slice(0, 4_000), {
          ...(preview ? { preview } : {}),
          ...(notes ? { notes } : {}),
        }]);
      }
    }

    return annotations.length ? Object.fromEntries(annotations) : undefined;
  }

  private toThreadSummary(conversation: ConversationEntity) {
    const updatedAt = this.toIsoString(conversation.updatedAt);

    return {
      id: conversation.id,
      cid: conversation.cid,
      title: conversation.title ?? 'New Conversation',
      preview: conversation.preview ?? '',
      status: conversation.status ?? 'active',
      updated_at: updatedAt,
      updatedAt,
    };
  }

  private async touchConversation(
    conversation: ConversationEntity,
    contentPreview: string,
  ) {
    conversation.preview = contentPreview.slice(0, 120);
    conversation.updatedAt = new Date();

    if (!conversation.title?.trim()) {
      conversation.title = contentPreview.slice(0, 20) || 'New Conversation';
    }

    await this.conversationRepo.save(conversation);
  }

  private async resolveAttachments(
    conversationId: string,
    assetIds: string[],
  ): Promise<MessageMedia[]> {
    const attachments: MessageMedia[] = [];
    const conversation = await this.getConversationByIdentifier(conversationId)
    for (const assetId of assetIds) {
      const asset = await this.getConversationAsset(conversation, assetId);
      attachments.push(this.toMessageMedia(asset));
    }

    return attachments;
  }

  private async resolveImplicitAttachments(
    conversation: ConversationEntity,
    content: string,
  ): Promise<MessageMedia[]> {
    const normalized = content.toLowerCase();
    const asksForDocument =
      normalized.includes('pdf') ||
      normalized.includes('paper') ||
      normalized.includes('论文') ||
      normalized.includes('文档') ||
      normalized.includes('这篇') ||
      normalized.includes('这个文件');

    if (!asksForDocument) {
      return [];
    }

    const manifest = await this.readConversationFileManifest(
      conversation.userId,
      conversation.id,
    );
    if (manifest.length === 0) {
      return [];
    }

    const latest = manifest[manifest.length - 1];
    return [this.toMessageMedia(latest)];
  }

  private toMessageMedia(asset: UploadedConversationFile): MessageMedia {
    return {
      id: asset.asset_id ?? asset.assetId,
      kind: asset.kind,
      url: asset.url,
      title: asset.title,
      mime_type: asset.mime_type,
      mimeType: asset.mimeType,
      storage_path: asset.storage_path,
      storagePath: asset.storagePath,
      size_bytes: asset.size_bytes,
      sizeBytes: asset.sizeBytes,
      created_at: asset.created_at,
      createdAt: asset.createdAt,
    };
  }

  private async persistUploadedFileRecords(
    conversation: ConversationEntity,
    asset: UploadedConversationFile,
  ) {
    const messageId = this.getUploadMessageId(asset);
    const resourceId = asset.asset_id ?? asset.assetId;
    const createdAt = new Date(asset.created_at ?? asset.createdAt ?? new Date().toISOString());
    const resourcePayload = {
      userId: conversation.userId,
      conversationId: conversation.id,
      messageId,
      resourceId,
      resourceKind: asset.kind,
      resourcePath: this.storableResourcePath(asset.url),
      mimeType: asset.mime_type ?? asset.mimeType,
      title: asset.title,
      sizeBytes: asset.size_bytes ?? asset.sizeBytes,
      createdAt,
    };

    await this.dataSource.transaction(async (manager) => {
      await manager.delete(MessageEntity, {
        userId: conversation.userId,
        conversationId: conversation.id,
        messageId,
        resourceId,
      });
      await manager.delete(ResourceEntity, {
        userId: conversation.userId,
        conversationId: conversation.id,
        messageId,
        resourceId,
      });

      const messageRepo = manager.getRepository(MessageEntity);
      const resourceRepo = manager.getRepository(ResourceEntity);
      await messageRepo.save(messageRepo.create(resourcePayload as Partial<MessageEntity>));
      await resourceRepo.save(resourceRepo.create(resourcePayload as Partial<ResourceEntity>));
    });
  }

  private getUploadMessageId(asset: UploadedConversationFile) {
    const existing = asset.upload_message_id ?? asset.uploadMessageId;
    if (existing) {
      return existing;
    }

    return `msg_upload_${asset.asset_id ?? asset.assetId}`;
  }

  private normalizeReplyFiles(fileField: unknown): MessageMedia[] {
    if (!fileField) {
      return [];
    }

    const items = Array.isArray(fileField) ? fileField : [fileField];
    const normalized: MessageMedia[] = [];

    for (const item of items) {
      if (typeof item !== 'object' || item === null) {
        continue;
      }

      const typedItem = item as Record<string, unknown>;
      const id =
        typeof typedItem.assetId === 'string'
          ? typedItem.assetId
          : typeof typedItem.id === 'string'
            ? typedItem.id
            : `asset-${randomUUID()}`;
      const path =
        typeof typedItem.path === 'string'
          ? typedItem.path
          : typeof typedItem.url === 'string'
            ? typedItem.url
            : undefined;

      if (!path) {
        continue;
      }

      normalized.push({
        id,
        kind:
          typeof typedItem.kind === 'string' && this.isSupportedMediaKind(typedItem.kind)
            ? typedItem.kind
            : this.detectMediaKindFromPath(path),
        url: path,
        title: typeof typedItem.title === 'string' ? typedItem.title : undefined,
        mime_type:
          typeof typedItem.mimeType === 'string'
            ? typedItem.mimeType
            : typeof typedItem.mime_type === 'string'
              ? typedItem.mime_type
              : undefined,
        storage_path: path,
        size_bytes:
          typeof typedItem.sizeBytes === 'number'
            ? typedItem.sizeBytes
            : typeof typedItem.size_bytes === 'number'
              ? typedItem.size_bytes
              : undefined,
        created_at: new Date().toISOString(),
      });
    }

    return normalized;
  }

  private async getConversationAsset(
    conversation: ConversationEntity,
    assetId: string,
  ): Promise<UploadedConversationFile> {
    const manifest = await this.readConversationFileManifest(
      conversation.userId,
      conversation.id,
    );
    const asset = manifest.find(
      (entry) => entry.asset_id === assetId || entry.assetId === assetId,
    );

    if (!asset) {
      throw new NotFoundException(`Asset ${assetId} not found`);
    }

    return asset;
  }

  private getConversationFilesDirectory(userId: number, conversationId: string) {
    return join(conversationFilesRootDir, String(userId), conversationId);
  }

  private getConversationManifestPath(userId: number, conversationId: string) {
    return join(
      this.getConversationFilesDirectory(userId, conversationId),
      manifestFileName,
    );
  }

  private async cleanupConversationFiles(conversation: ConversationEntity) {
    await Promise.all([
      this.removeRuntimeSessionFile(conversation),
      this.removeConversationFilesDirectory(conversation.userId, conversation.id),
      this.removeLegacyConversationFilesDirectory(conversation.id),
    ]);
  }

  private async retryPendingConversationCleanupTasks(): Promise<void> {
    const tasks = await this.cleanupTaskRepo.find({
      where: {
        status: In(['pending', 'running', 'failed']),
      },
      order: { createdAt: 'ASC' },
      take: 100,
    });
    for (const task of tasks) {
      if (task.attempts >= 10) continue;
      try {
        await this.processConversationMemoryCleanupTask(task);
      } catch (error) {
        console.error('[ConversationService] cleanup task retry failed', {
          cleanupTaskId: task.id,
          conversationId: task.conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async processConversationMemoryCleanupTask(
    task: ConversationCleanupTaskEntity,
  ): Promise<void> {
    const attempt = task.attempts + 1;
    await this.cleanupTaskRepo.update(task.id, {
      status: 'running',
      attempts: attempt,
      lastError: null,
      updatedAt: new Date(),
    });
    try {
      await deleteConversationMemorySession(task.userId, task.conversationId);
      const completedAt = new Date();
      await this.cleanupTaskRepo.update(task.id, {
        status: 'completed',
        attempts: attempt,
        lastError: null,
        updatedAt: completedAt,
        completedAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.cleanupTaskRepo.update(task.id, {
        status: 'failed',
        attempts: attempt,
        lastError: message.slice(0, 4000),
        updatedAt: new Date(),
      });
      throw error;
    }
  }

  private async removeRuntimeSessionFile(conversation: ConversationEntity) {
    let sessionFilePath: string;

    try {
      sessionFilePath = await this.findOrCreateRuntimeSessionFile(
        conversation.id,
        conversation.userId,
        true,
      );
    } catch (error) {
      if (error instanceof NotFoundException || this.isEnoent(error)) {
        return;
      }

      throw error;
    }

    await rm(this.resolveRemovableChildPath(userDataRootDir, sessionFilePath), {
      force: true,
    });
  }

  private async removeConversationFilesDirectory(userId: number, conversationId: string) {
    await rm(
      this.resolveRemovableChildPath(
        conversationFilesRootDir,
        this.getConversationFilesDirectory(userId, conversationId),
      ),
      {
        recursive: true,
        force: true,
      },
    );
  }

  private async removeLegacyConversationFilesDirectory(conversationId: string) {
    const legacyDir = this.resolveRemovableChildPath(
      conversationFilesRootDir,
      join(conversationFilesRootDir, conversationId),
    );

    try {
      await stat(join(legacyDir, manifestFileName));
    } catch (error) {
      if (this.isEnoent(error)) {
        return;
      }

      throw error;
    }

    await rm(legacyDir, {
      recursive: true,
      force: true,
    });
  }

  private resolveRemovableChildPath(rootDir: string, targetPath: string) {
    const resolvedRoot = resolve(rootDir);
    const resolvedTarget = resolve(targetPath);
    const relativePath = relative(resolvedRoot, resolvedTarget);

    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error(`Refusing to remove path outside ${resolvedRoot}: ${resolvedTarget}`);
    }

    return resolvedTarget;
  }

  private async readRuntimeSessionMessages(
    sessionId: string,
    userId?: number,
  ): Promise<ConversationMessage[]> {
    let sessionFilePath: string;
    try {
      sessionFilePath = await this.findOrCreateRuntimeSessionFile(sessionId, userId, true);
    } catch {
      return [];
    }
    const mediaByMessageId = await this.getMessageResourceMappings(sessionId, userId);
    const publicMediaByMessageId = new Map<string, MessageMedia[]>();

    for (const [messageId, media] of mediaByMessageId) {
      publicMediaByMessageId.set(
        messageId,
        media.map((item) => this.toPublicMessageMedia(item)),
      );
    }

    return this.transcriptProjection.projectTranscriptFile({
      filePath: sessionFilePath,
      sessionId,
      mediaByMessageId: publicMediaByMessageId,
      conversationMemoryDir: userId === undefined
        ? undefined
        : getNetworkConversationMemoryDir(userId),
    });
  }

  private consumeRuntimeEvent(
    event: RuntimeJsonlEvent,
    sessionId: string,
    messageMap: Map<string, ConversationMessage>,
    messageOrder: string[],
  ) {
    if (event.type === 'user') {
      const normalized = this.normalizeRuntimeUserEvent(event, sessionId);
      if (normalized) {
        this.upsertRuntimeMessage(normalized, messageMap, messageOrder);
      }
      return;
    }

    if (event.type === 'assistant') {
      const normalized = this.normalizeRuntimeAssistantEvent(event, sessionId);
      if (normalized) {
        this.upsertRuntimeMessage(normalized, messageMap, messageOrder);
      }
    }
  }

  private normalizeRuntimeUserEvent(
    event: RuntimeJsonlEvent,
    sessionId: string,
  ): ConversationMessage | null {
    const role = event.message?.role;
    const createdAt = event.timestamp ?? new Date().toISOString();

    if (role !== 'user') {
      return null;
    }

    const content = event.message?.content;

    if (typeof content === 'string') {
      return {
        id:
          event.message?.id ??
          event.uuid ??
          event.promptId ??
          `user-${randomUUID()}`,
        thread_id: sessionId,
        threadId: sessionId,
        role: 'user',
        kind: 'markdown',
        content,
        created_at: createdAt,
        createdAt,
      };
    }

    return null;
  }

  private normalizeRuntimeAssistantEvent(
    event: RuntimeJsonlEvent,
    sessionId: string,
  ): ConversationMessage | null {
    const assistantMessageId = event.message?.id ?? event.uuid;
    const createdAt = event.timestamp ?? new Date().toISOString();

    if (!assistantMessageId || event.message?.role !== 'assistant') {
      return null;
    }

    const rawContent = event.message?.content;
    const topLevelReasoning = this.normalizeReasoningText(
      event.message?.reasoning ?? event.message?.think ?? event.message?.thinking,
    );
    if (typeof rawContent === 'string' && rawContent.trim()) {
      return {
        id: assistantMessageId,
        thread_id: sessionId,
        threadId: sessionId,
        role: 'assistant',
        kind: 'markdown',
        content: rawContent.trim(),
        reasoning: topLevelReasoning ?? undefined,
        think: topLevelReasoning ?? undefined,
        actions: Array.isArray(event.message?.actions) && event.message.actions.length
          ? event.message.actions
          : undefined,
        created_at: createdAt,
        createdAt,
      };
    }

    const contentBlocks = Array.isArray(rawContent)
      ? rawContent
      : [];
    const textParts: string[] = [];
    const reasoningParts: string[] = [];

    for (const block of contentBlocks) {
      if (typeof block !== 'object' || block === null) {
        continue;
      }

      const typedBlock = block as Record<string, unknown>;
      const blockPhase = this.getAssistantContentPhase(typedBlock);
      if (blockPhase === 'process') {
        const blockReasoning = this.extractAssistantReasoningBlock(typedBlock);
        if (blockReasoning) {
          reasoningParts.push(blockReasoning);
        }
        continue;
      }

      if (blockPhase === 'final') {
        const blockText = this.extractAssistantFinalBlock(typedBlock);
        if (blockText) {
          textParts.push(blockText);
        }
        continue;
      }

      const blockReasoning = this.extractAssistantReasoningBlock(typedBlock);
      if (blockReasoning) {
        reasoningParts.push(blockReasoning);
        continue;
      }

      const blockText = this.extractAssistantFinalBlock(typedBlock);
      if (blockText) {
        textParts.push(blockText);
      }

    }

    const content = textParts.join('\n').trim();
    const reasoning = this.normalizeReasoningText(
      [topLevelReasoning, ...reasoningParts].filter(Boolean).join('\n'),
    );

    if (!content && !reasoning) {
      return null;
    }

    return {
      id: assistantMessageId,
      thread_id: sessionId,
      threadId: sessionId,
      role: 'assistant',
      kind: content ? 'markdown' : 'status',
      content: content || 'Assistant is thinking...',
      reasoning: reasoning || undefined,
      think: reasoning || undefined,
      actions: Array.isArray(event.message?.actions) && event.message.actions.length
        ? event.message.actions
        : undefined,
      created_at: createdAt,
      createdAt,
    };
  }

  private normalizeReasoningText(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = sanitizeServerPhysicalPaths(value).trim();
    return normalized ? normalized : null;
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
      return this.formatAssistantProcessBlock(block);
    }

    const explicitReasoning = this.normalizeReasoningText(
      block.thinking ?? block.reasoning ?? block.text ?? block.content,
    );
    if (explicitReasoning) {
      return explicitReasoning;
    }

    return this.formatAssistantProcessBlock(block);
  }

  private extractAssistantFinalBlock(block: Record<string, unknown>): string | null {
    const phase = this.getAssistantContentPhase(block);
    if (phase === 'process') {
      return null;
    }

    if (phase !== 'final' && block.type !== 'text') {
      return null;
    }

    return this.normalizeReasoningText(block.text ?? block.content);
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

  private formatAssistantProcessBlock(block: Record<string, unknown>): string | null {
    const blockType = typeof block.type === 'string' ? block.type : 'unknown';
    if (blockType === 'text') {
      return null;
    }

    if (this.isToolFacingAssistantBlock(blockType, block)) {
      return this.formatFilteredAssistantToolBlock(blockType, block);
    }

    return [
      '[过程事件]',
      '正在处理过程事件。',
    ].join('\n');
  }

  private formatFilteredAssistantToolBlock(
    blockType: string,
    block: Record<string, unknown>,
  ): string {
    if (this.isToolResultAssistantBlock(blockType, block)) {
      return this.formatSanitizedAssistantToolResult(block);
    }

    return [
      '[工具调用]',
      '正在调用工具。',
    ].join('\n');
  }

  private isToolResultAssistantBlock(
    blockType: string,
    block: Record<string, unknown>,
  ) {
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

  private formatSanitizedAssistantToolResult(block: Record<string, unknown>): string {
    const rawResult = this.extractAssistantToolResultText(block);
    const resultText = this.redactSensitiveReasoningText(rawResult);
    return [
      '[工具返回]',
      resultText || (block.is_error === true || block.isError === true ? '工具返回错误。' : '工具已返回。'),
    ].join('\n');
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
          return this.stringifyAssistantToolResultValue(typedItem);
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
    return output;
  }

  private isToolResultContentBlock(item: unknown) {
    if (typeof item !== 'object' || item === null) {
      return false;
    }

    const typedItem = item as Record<string, unknown>;
    const type = typeof typedItem.type === 'string' ? typedItem.type : '';
    return (
      type === 'tool_result' ||
      type.endsWith('_tool_result') ||
      (typeof typedItem.tool_use_id === 'string' && type !== 'text')
    );
  }

  private isToolFacingAssistantBlock(
    type: unknown,
    block?: Record<string, unknown>,
  ) {
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

  private upsertRuntimeMessage(
    message: ConversationMessage,
    messageMap: Map<string, ConversationMessage>,
    messageOrder: string[],
  ) {
    const existing = messageMap.get(message.id);

    if (!existing) {
      messageMap.set(message.id, message);
      messageOrder.push(message.id);
      return;
    }

    const mergedReasoning =
      this.normalizeReasoningText(message.reasoning ?? message.think) ??
      this.normalizeReasoningText(existing.reasoning ?? existing.think) ??
      undefined;

    messageMap.set(message.id, {
      ...existing,
      content:
        message.content && message.content !== 'Assistant is thinking...'
          ? message.content
          : existing.content,
      reasoning: mergedReasoning,
      think: mergedReasoning,
      actions: this.mergeMessageActions(existing.actions, message.actions),
      kind: message.kind === 'markdown' ? 'markdown' : existing.kind,
      created_at: existing.created_at,
      createdAt: existing.createdAt,
    });
  }

  private async findOrCreateRuntimeSessionFile(sessionId: string, userId?: number, readOnly = false) {
    try {
      return await findNetworkTranscriptFile(sessionId, userId, { readOnly });
    } catch (error) {
      if (readOnly) {
        throw new NotFoundException(`Runtime session ${sessionId} not found`);
      }
      throw error;
    }
  }

  private async ensureConversationFileManifest(
    userId: number,
    conversationId: string,
  ) {
    const manifestPath = this.getConversationManifestPath(userId, conversationId);
    const conversationDir = this.getConversationFilesDirectory(userId, conversationId);

    await mkdir(conversationDir, { recursive: true });

    try {
      await readFile(manifestPath, 'utf8');
    } catch (error) {
      if (!this.isEnoent(error)) {
        throw error;
      }

      await writeFile(manifestPath, '[]\n', 'utf8');
    }
  }

  private async readConversationFileManifest(
    userId: number,
    conversationId: string,
  ): Promise<UploadedConversationFile[]> {
    const manifestPath = this.getConversationManifestPath(userId, conversationId);
    await this.ensureConversationFileManifest(userId, conversationId);

    const rawContent = await readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(rawContent) as unknown;

    if (!Array.isArray(parsed)) {
      throw new Error(`Conversation file manifest is invalid: ${manifestPath}`);
    }

    return parsed as UploadedConversationFile[];
  }

  private async writeConversationFileManifest(
    userId: number,
    conversationId: string,
    assets: UploadedConversationFile[],
  ) {
    const manifestPath = this.getConversationManifestPath(userId, conversationId);
    await this.ensureConversationFileManifest(userId, conversationId);
    await writeFile(manifestPath, JSON.stringify(assets, null, 2) + '\n', 'utf8');
  }

  private async getMessageResourceMappings(conversationId: string, userId?: number) {
    const where = userId !== undefined
      ? { conversationId, userId }
      : { conversationId };
    const rows = await this.messageResourceRepo.find({
      where,
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    const mapping = new Map<string, MessageMedia[]>();

    for (const row of rows) {
      if (!row.messageId || !row.resourceId || !row.resourcePath || !row.resourceKind) {
        continue;
      }

      const url = this.createConversationFileDownloadUrl(
        row.resourcePath,
        row.userId,
        row.conversationId,
      );
      const existing = mapping.get(row.messageId) ?? [];
      existing.push({
        id: row.resourceId,
        kind: row.resourceKind as MessageMedia['kind'],
        url,
        title: row.title,
        artifact_id: row.artifactId,
        artifactId: row.artifactId,
        download_url: url,
        downloadUrl: url,
        mime_type: row.mimeType,
        mimeType: row.mimeType,
        size_bytes: row.sizeBytes,
        sizeBytes: row.sizeBytes,
        created_at: row.createdAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      });
      mapping.set(row.messageId, existing);
    }

    return mapping;
  }

  private async skillOutputFilesToMedia(
    outputFiles: Array<{
      path?: string;
      url?: string;
      kind?: string;
      title?: string;
      mimeType?: string;
      sizeBytes?: number;
    }>,
    userId?: number,
  ): Promise<MessageMedia[]> {
    const media: MessageMedia[] = [];
    const uid = userId === undefined
      ? ''
      : await this.getPublicUserId(userId);
    for (const f of outputFiles) {
      const storagePath = f.path ?? f.url;
      if (!storagePath) {
        continue;
      }

      const kind = this.isSupportedMediaKind(f.kind)
        ? f.kind
        : this.detectMediaKindFromPath(storagePath);
      const filename = this.displayNameFromPath(storagePath);
      const url = f.url && !looksLikeServerPhysicalPath(f.url)
        ? f.url
        : this.toGeneratedPublicUrl(storagePath, kind, uid);
      media.push({
        id: `asset-${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        kind,
        url,
        title: f.title ?? filename,
        mime_type: f.mimeType,
        mimeType: f.mimeType,
        storage_path: storagePath,
        storagePath: storagePath,
        size_bytes: f.sizeBytes,
        sizeBytes: f.sizeBytes,
        created_at: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });
    }
    return media;
  }

  private async getPublicUserId(userId: number) {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ['publicUserId'],
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user.publicUserId;
  }

  private isSupportedMediaKind(kind: unknown): kind is MessageMediaKind {
    return typeof kind === 'string' && supportedMediaKinds.has(kind as MessageMediaKind);
  }

  private detectMediaKindFromPath(pathOrUrl: string): MessageMediaKind {
    const detected = detectOutputType(this.pathWithoutQuery(pathOrUrl));
    return this.isSupportedMediaKind(detected) ? detected : 'file';
  }

  private toGeneratedPublicUrl(pathOrUrl: string, kind: MessageMediaKind, userId: string | number) {
    if (this.isPublicUrl(pathOrUrl) || pathOrUrl.startsWith('/api/')) {
      return pathOrUrl;
    }

    const cleanPath = this.pathWithoutQuery(pathOrUrl);
    const filename = basename(cleanPath);
    if (kind === 'app') {
      return `/api/career-agent/generated/${userId}/app/${filename}/`;
    }

    return `/api/career-agent/generated/${userId}/${kind}/${filename}`;
  }

  private displayNameFromPath(pathOrUrl: string) {
    try {
      if (this.isPublicUrl(pathOrUrl)) {
        const parsed = new URL(pathOrUrl);
        const name = basename(parsed.pathname);
        return name || parsed.hostname;
      }
    } catch {
      // Fall back to path handling below.
    }

    const name = basename(this.pathWithoutQuery(pathOrUrl));
    return name || 'generated-artifact';
  }

  private pathWithoutQuery(pathOrUrl: string) {
    return pathOrUrl.split(/[?#]/, 1)[0] ?? pathOrUrl;
  }

  private toPublicMessageMedia(resource: MessageMedia): MessageMedia {
    const {
      storage_path: _storagePath,
      storagePath: _storagePathAlias,
      ...publicResource
    } = resource;
    return publicResource;
  }

  private toPublicUploadedConversationFile(asset: UploadedConversationFile) {
    const {
      storage_path: _storagePath,
      storagePath: _storagePathAlias,
      ...publicAsset
    } = asset;
    return publicAsset;
  }

  private withConversationFileDownloadUrl<T extends { url: string; download_url?: string; downloadUrl?: string }>(
    value: T,
    userId: number,
    conversationId: string,
  ): T {
    const downloadUrl = this.createConversationFileDownloadUrl(value.url, userId, conversationId);
    if (downloadUrl === value.url) {
      return value;
    }

    return {
      ...value,
      url: downloadUrl,
      download_url: downloadUrl,
      downloadUrl,
    };
  }

  private createConversationFileDownloadUrl(pathOrUrl: string, userId: number, fallbackConversationId: string) {
    const cleanPathOrUrl = this.pathWithoutQuery(pathOrUrl);
    const parsed = this.parseConversationFilePublicPath(cleanPathOrUrl);
    if (!parsed) {
      return pathOrUrl;
    }

    const conversationId = parsed.conversationId || fallbackConversationId;
    const downloadToken = createFileDownloadToken({
      userId,
      conversationId,
      fileName: parsed.fileName,
    });

    return `${cleanPathOrUrl}?download_token=${encodeURIComponent(downloadToken)}`;
  }

  private parseConversationFilePublicPath(pathOrUrl: string) {
    let pathname = pathOrUrl;

    if (this.isPublicUrl(pathOrUrl)) {
      try {
        const parsed = new URL(pathOrUrl);
        pathname = parsed.pathname;
      } catch {
        return undefined;
      }
    }

    const match = pathname.match(/^\/api\/career-agent\/threads\/([^/]+)\/files\/([^/]+)$/);
    if (!match) {
      return undefined;
    }

    return {
      conversationId: decodeURIComponent(match[1]),
      fileName: decodeURIComponent(match[2]),
    };
  }

  private isPublicUrl(value: string) {
    return /^https?:\/\//i.test(value);
  }

  private async persistAssistantGeneratedResources(
    userId: number,
    conversationId: string,
    messageId: string,
    resources: MessageMedia[],
  ): Promise<{ media: MessageMedia[]; actions: MessageAction[] }> {
    const media: MessageMedia[] = [];
    const actions: MessageAction[] = [];

    for (const resource of resources) {
      const enriched = { ...resource };
      try {
        const artifact = await this.artifactService.createArtifact({
          userId,
          conversationId,
          messageId,
          type: this.artifactTypeForMedia(enriched.kind),
          kind: enriched.kind,
          title: enriched.title ?? this.displayNameFromPath(enriched.url),
          renderMode: 'url',
          payloadPath: enriched.url,
          url: enriched.url,
          storagePath: enriched.storage_path ?? enriched.storagePath,
          mimeType: enriched.mime_type ?? enriched.mimeType,
          sizeBytes: enriched.size_bytes ?? enriched.sizeBytes,
          summary: `Generated ${enriched.kind} artifact`,
        });
        enriched.artifact_id = String(artifact.id);
        enriched.artifactId = String(artifact.id);

        const action = this.artifactActionForMedia(enriched, String(artifact.id));
        if (action) {
          actions.push(action);
        }
      } catch (err: any) {
        skillLogger.error('ConversationService', `Failed to create generated artifact: ${err?.message ?? err}`);
      }

      media.push(this.toPublicMessageMedia(enriched));
    }

    return { media, actions };
  }

  private artifactTypeForMedia(kind: MessageMediaKind) {
    const types: Record<MessageMediaKind, string> = {
      image: 'generated-image',
      audio: 'generated-audio',
      video: 'generated-video',
      html: 'generated-html',
      app: 'generated-app',
      file: 'generated-file',
    };
    return types[kind];
  }

  private artifactActionForMedia(media: MessageMedia, artifactId: string): MessageAction | null {
    if (media.kind !== 'app' && media.kind !== 'html' && media.kind !== 'file') {
      return null;
    }

    const labels: Record<MessageMediaKind, string> = {
      image: '查看图片',
      audio: '播放音频',
      video: '播放视频',
      html: '打开页面',
      app: '打开应用',
      file: '打开文件',
    };

    return {
      id: `action-open-artifact-${artifactId}`,
      kind: 'open_artifact',
      label: labels[media.kind],
      artifact_id: artifactId,
      artifactId,
      view_mode: media.kind === 'app' || media.kind === 'html' ? 'focus' : 'pane',
      viewMode: media.kind === 'app' || media.kind === 'html' ? 'focus' : 'pane',
    };
  }

  private async mergeAssistantMessageActions(
    sessionFilePath: string,
    assistantMessageId: string,
    actions: MessageAction[],
  ) {
    if (!actions.length) {
      return;
    }

    const sessionContent = await readFile(sessionFilePath, 'utf8');
    const lines = sessionContent.trimEnd().split('\n');
    let updated = false;

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed.type === 'assistant' && parsed.message?.id === assistantMessageId) {
          const existingActions = Array.isArray(parsed.message.actions)
            ? parsed.message.actions
            : [];
          parsed.message.actions = this.mergeMessageActions(existingActions, actions);
          lines[i] = JSON.stringify(parsed);
          updated = true;
        }
      } catch {
        // Ignore malformed legacy lines and keep scanning.
      }
    }

    if (updated) {
      await writeFile(sessionFilePath, lines.join('\n') + '\n', 'utf8');
    }
  }

  private mergeMessageActions(
    existingActions: MessageAction[] | undefined,
    newActions: MessageAction[] | undefined,
  ) {
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

  private async replaceMessageResourceMappings(
    userId: number,
    conversationId: string,
    messageId: string,
    resources: MessageMedia[],
  ) {
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(ResourceEntity, { userId, conversationId, messageId });
      await manager.delete(MessageEntity, { userId, conversationId, messageId });

      if (!resources.length) {
        return;
      }

      const resourcePayloads = resources.map((resource) =>
        this.toResourceMappingPayload(userId, conversationId, messageId, resource),
      );
      const messagePayloads = resourcePayloads.map(({ artifactId, ...payload }) => payload);
      const resourceRepo = manager.getRepository(ResourceEntity);
      const messageRepo = manager.getRepository(MessageEntity);

      await resourceRepo.save(
        resourcePayloads.map((payload) => resourceRepo.create(payload as Partial<ResourceEntity>)),
      );
      await messageRepo.save(
        messagePayloads.map((payload) => messageRepo.create(payload as Partial<MessageEntity>)),
      );
    });
  }

  private async linkUploadedResourcesToMessage(
    userId: number,
    conversationId: string,
    messageId: string,
    resources: MessageMedia[],
  ) {
    const resourceIds = [...new Set(resources.map((resource) => resource.id).filter(Boolean))];
    if (!resourceIds.length) {
      return;
    }

    await this.dataSource.transaction(async (manager) => {
      const resourceRepo = manager.getRepository(ResourceEntity);
      const messageRepo = manager.getRepository(MessageEntity);

      for (const resource of resources) {
        if (!resource.id) {
          continue;
        }

        const resourcePayload = this.toResourceMappingPayload(userId, conversationId, messageId, resource);
        const messagePayload = (({ artifactId, ...payload }) => payload)(resourcePayload);

        const resourceRows = await resourceRepo.find({
          where: { userId, conversationId, resourceId: resource.id },
          order: { createdAt: 'ASC', id: 'ASC' },
        });
        const resourceCandidates = resourceRows.filter(
          (row) => row.messageId === messageId || row.messageId?.startsWith('msg_upload_'),
        );
        const resourceRow =
          resourceCandidates.find((row) => row.messageId === messageId) ??
          resourceCandidates.find((row) => row.messageId?.startsWith('msg_upload_'));

        if (resourceRow) {
          for (const duplicate of resourceCandidates) {
            if (duplicate.id !== resourceRow.id) {
              await resourceRepo.delete({ id: duplicate.id });
            }
          }
          await resourceRepo.save(resourceRepo.merge(resourceRow, resourcePayload));
        } else {
          await resourceRepo.save(resourceRepo.create(resourcePayload as Partial<ResourceEntity>));
        }

        const messageRows = await messageRepo.find({
          where: { userId, conversationId, resourceId: resource.id },
          order: { createdAt: 'ASC', id: 'ASC' },
        });
        const messageCandidates = messageRows.filter(
          (row) => row.messageId === messageId || row.messageId?.startsWith('msg_upload_'),
        );
        const messageRow =
          messageCandidates.find((row) => row.messageId === messageId) ??
          messageCandidates.find((row) => row.messageId?.startsWith('msg_upload_'));

        if (messageRow) {
          for (const duplicate of messageCandidates) {
            if (duplicate.id !== messageRow.id) {
              await messageRepo.delete({ id: duplicate.id });
            }
          }
          await messageRepo.save(messageRepo.merge(messageRow, messagePayload as Partial<MessageEntity>));
        } else {
          await messageRepo.save(messageRepo.create(messagePayload as Partial<MessageEntity>));
        }
      }
    });
  }

  private toResourceMappingPayload(
    userId: number,
    conversationId: string,
    messageId: string,
    resource: MessageMedia,
  ) {
    return {
      userId,
      messageId,
      conversationId,
      resourceId: resource.id,
      artifactId: resource.artifact_id ?? resource.artifactId,
      resourceKind: resource.kind,
      resourcePath: this.storableResourcePath(resource.url),
      mimeType: resource.mime_type ?? resource.mimeType,
      title: resource.title,
      sizeBytes: resource.size_bytes ?? resource.sizeBytes,
      createdAt: new Date(
        resource.created_at ?? resource.createdAt ?? new Date().toISOString(),
      ),
    };
  }

  private storableResourcePath(pathOrUrl: string) {
    const cleanPathOrUrl = this.pathWithoutQuery(pathOrUrl);
    return this.parseConversationFilePublicPath(cleanPathOrUrl) ? cleanPathOrUrl : pathOrUrl;
  }

  private validateUpload(
    file: Express.Multer.File,
    originalName: string,
    mimeType: string,
  ) {
    const extension = extname(originalName).toLowerCase();
    const policy = uploadPolicies[extension];

    if (!policy) {
      throw new UnsupportedMediaTypeException(
        'Unsupported file type. Allowed: image, mp4, txt, md, pdf, doc, docx.',
      );
    }

    if (file.size > policy.maxBytes) {
      throw new BadRequestException(
        `File exceeds size limit for ${extension} uploads (${policy.maxBytes} bytes).`,
      );
    }

    if (
      mimeType &&
      !genericUploadMimeTypes.has(mimeType) &&
      !policy.allowedMimeTypes.includes(mimeType)
    ) {
      throw new UnsupportedMediaTypeException(
        `Mime type ${mimeType} does not match file extension ${extension}.`,
      );
    }

    this.validateUploadContent(file.buffer, extension);

    return { policy };
  }

  private validateUploadContent(buffer: Buffer | undefined, extension: string) {
    if (!buffer) {
      throw new BadRequestException('file buffer is missing');
    }

    const lowerExtension = extension.toLowerCase();
    let valid = false;

    switch (lowerExtension) {
      case '.png':
        valid = this.hasMagic(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        break;
      case '.jpg':
      case '.jpeg':
        valid = this.hasMagic(buffer, [0xff, 0xd8, 0xff]);
        break;
      case '.webp':
        valid =
          buffer.length >= 12 &&
          buffer.toString('ascii', 0, 4) === 'RIFF' &&
          buffer.toString('ascii', 8, 12) === 'WEBP';
        break;
      case '.gif':
        valid =
          buffer.length >= 6 &&
          (buffer.toString('ascii', 0, 6) === 'GIF87a' ||
            buffer.toString('ascii', 0, 6) === 'GIF89a');
        break;
      case '.mp4':
        valid = buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp';
        break;
      case '.pdf':
        valid = this.hasMagic(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d]);
        break;
      case '.doc':
        valid = this.hasMagic(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
        break;
      case '.docx':
        valid =
          this.hasMagic(buffer, [0x50, 0x4b, 0x03, 0x04]) &&
          this.bufferIncludesAscii(buffer, '[Content_Types].xml') &&
          this.bufferIncludesAscii(buffer, 'word/');
        break;
      case '.txt':
      case '.md':
        valid = this.looksLikeTextBuffer(buffer);
        break;
      default:
        valid = false;
    }

    if (!valid) {
      throw new UnsupportedMediaTypeException(
        `File content does not match the declared ${lowerExtension} type.`,
      );
    }
  }

  private hasMagic(buffer: Buffer, magic: number[], offset = 0) {
    if (buffer.length < offset + magic.length) {
      return false;
    }
    return magic.every((byte, index) => buffer[offset + index] === byte);
  }

  private bufferIncludesAscii(buffer: Buffer, value: string) {
    return buffer.includes(Buffer.from(value, 'ascii'));
  }

  private looksLikeTextBuffer(buffer: Buffer) {
    if (buffer.length === 0) {
      return true;
    }

    if (
      this.hasMagic(buffer, [0xef, 0xbb, 0xbf]) ||
      this.hasMagic(buffer, [0xff, 0xfe]) ||
      this.hasMagic(buffer, [0xfe, 0xff])
    ) {
      return true;
    }

    let nullBytes = 0;
    let oddNullBytes = 0;
    let evenNullBytes = 0;
    let suspiciousControlBytes = 0;

    for (let i = 0; i < buffer.length; i += 1) {
      const byte = buffer[i]!;
      if (byte === 0) {
        nullBytes += 1;
        if (i % 2 === 0) evenNullBytes += 1;
        else oddNullBytes += 1;
        continue;
      }

      if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) {
        suspiciousControlBytes += 1;
      }
    }

    if (nullBytes > 0) {
      const dominantNullSide = Math.max(oddNullBytes, evenNullBytes);
      const looksLikeUtf16 = dominantNullSide / nullBytes > 0.8;
      if (!looksLikeUtf16) {
        return false;
      }
    }

    return suspiciousControlBytes / buffer.length <= 0.01;
  }

  private async prepareAttachmentsForModel(
    conversation: ConversationEntity,
    userContent: string,
    attachments: MessageMedia[],
  ): Promise<PreparedAttachmentPayload> {
    if (!attachments.length) {
      return { content: userContent, attachmentsForAgent: [] };
    }

    const textBlocks: string[] = [];
    const attachmentsForAgent: PreparedAttachmentPayload['attachmentsForAgent'] = [];

    for (const attachment of attachments) {
      const descriptor = await this.describeAttachmentForModel(conversation, attachment);
      if (descriptor.injectedText) {
        textBlocks.push(descriptor.injectedText);
      }
      if (descriptor.forwardToAgent) {
        attachmentsForAgent.push({
          assetId: attachment.id,
          path: attachment.storage_path ?? attachment.storagePath ?? attachment.url,
          title: attachment.title,
          mimeType: attachment.mime_type ?? attachment.mimeType,
        });
      }
    }

    if (!textBlocks.length) {
      return { content: userContent, attachmentsForAgent };
    }

    const attachmentContext = [
      '<attachment_context>',
      ...textBlocks,
      '</attachment_context>',
    ].join('\n');

    return {
      content: [userContent, '', attachmentContext].join('\n').trim(),
      attachmentsForAgent,
    };
  }

  private async describeAttachmentForModel(
    conversation: ConversationEntity,
    attachment: MessageMedia,
  ) {
    const filePath = this.resolveAttachmentDiskPath(
      conversation.userId,
      conversation.id,
      attachment,
    );
    const fileName = attachment.title ?? basename(filePath);
    const mimeType = (attachment.mime_type ?? attachment.mimeType ?? '').toLowerCase();
    const extension = extname(fileName).toLowerCase();
    const policy = uploadPolicies[extension];
    const fileStats = await stat(filePath);

    if (!policy) {
      return {
        injectedText: this.createAttachmentFallbackBlock(
          fileName,
          filePath,
          mimeType,
          fileStats.size,
        ),
        forwardToAgent: true,
      };
    }

    if (policy.kind === 'image') {
      return {
        injectedText: '',
        forwardToAgent: true,
      };
    }

    if (policy.kind === 'video') {
      return {
        injectedText: [
          `[Video attachment]`,
          `name: ${fileName}`,
          `path: ${filePath}`,
          `mime: ${mimeType || 'unknown'}`,
          `size_bytes: ${fileStats.size}`,
          `The uploaded video is attached. Use this metadata and request additional details if direct video understanding is unavailable.`,
        ].join('\n'),
        forwardToAgent: true,
      };
    }

    if (extension === '.pdf') {
      return {
        injectedText: '',
        forwardToAgent: true,
      };
    }

    const extractedText = await this.extractTextAttachmentContent(
      filePath,
      extension,
      fileName,
    );
    return {
      injectedText: [
        `[Text attachment]`,
        `name: ${fileName}`,
        `path: ${filePath}`,
        `mime: ${mimeType || 'unknown'}`,
        `size_bytes: ${fileStats.size}`,
        extractedText,
      ].join('\n'),
      forwardToAgent: false,
    };
  }

  private async extractTextAttachmentContent(
    filePath: string,
    extension: string,
    fileName: string,
  ): Promise<string> {
    if (extension === '.txt' || extension === '.md') {
      const content = await this.readTextFileWithEncodingFallback(filePath);
      return this.wrapExtractedText(content);
    }

    if (extension === '.docx') {
      const content = await this.extractDocxText(filePath);
      if (content.trim()) {
        return this.wrapExtractedText(content);
      }
    }

    if (extension === '.doc') {
      const docSnippet = await this.extractBinaryTextSnippet(filePath, 10_000);
      if (docSnippet.trim()) {
        return this.wrapExtractedText(docSnippet);
      }
      return this.wrapExtractedText(
        `[The legacy .doc file ${fileName} could not be fully decoded. Filename and file metadata were preserved for the model.]`,
      );
    }

    const fallback = await this.extractBinaryTextSnippet(filePath, 8_000);
    return this.wrapExtractedText(
      fallback || `[No readable text could be extracted from ${fileName}.]`,
    );
  }

  private async extractDocxText(filePath: string): Promise<string> {
    const shell = process.platform === 'win32' ? 'powershell' : 'pwsh';
    const escapedPath = filePath.replace(/'/g, "''");
    const script = [
      `Add-Type -AssemblyName System.IO.Compression.FileSystem`,
      `$zip = [System.IO.Compression.ZipFile]::OpenRead('${escapedPath}')`,
      `try {`,
      `  $entry = $zip.GetEntry('word/document.xml')`,
      `  if ($null -eq $entry) { exit 0 }`,
      `  $reader = New-Object System.IO.StreamReader($entry.Open())`,
      `  try {`,
      `    $xml = $reader.ReadToEnd()`,
      `    [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($xml))`,
      `  } finally { $reader.Dispose() }`,
      `} finally { $zip.Dispose() }`,
    ].join('; ');

    const result = await execFileNoThrow(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 10_000,
      useCwd: false,
    });

    if (result.code !== 0 || !result.stdout.trim()) {
      return this.extractBinaryTextSnippet(filePath, 10_000);
    }

    let xmlContent = '';
    try {
      xmlContent = Buffer.from(result.stdout.trim(), 'base64').toString('utf8');
    } catch {
      xmlContent = result.stdout;
    }

    return this.decodeXmlEntities(
      xmlContent
        .replace(/<w:p[^>]*>/g, '\n')
        .replace(/<w:tab\/>/g, '\t')
        .replace(/<w:br\/>/g, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim(),
    );
  }

  private async extractBinaryTextSnippet(filePath: string, maxChars: number) {
    const buffer = await readFile(filePath);
    const asciiMatches = buffer
      .toString('latin1')
      .match(/[ -~\r\n\t]{4,}/g)
      ?.map((chunk) => chunk.trim())
      .filter(Boolean) ?? [];

    const utf16Matches = buffer
      .toString('utf16le')
      .match(/[^\u0000-\u001f]{4,}/g)
      ?.map((chunk) => chunk.trim())
      .filter(Boolean) ?? [];

    const unique = Array.from(new Set([...asciiMatches, ...utf16Matches]));
    const joined = unique.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return this.truncateExtractedText(joined, maxChars);
  }

  private async readTextFileWithEncodingFallback(filePath: string) {
    const buffer = await readFile(filePath);

    if (buffer.length >= 2) {
      if (buffer[0] === 0xff && buffer[1] === 0xfe) {
        return buffer.toString('utf16le');
      }
      if (buffer[0] === 0xfe && buffer[1] === 0xff) {
        const swapped = Buffer.allocUnsafe(buffer.length - 2);
        for (let i = 2; i + 1 < buffer.length; i += 2) {
          swapped[i - 2] = buffer[i + 1]!;
          swapped[i - 1] = buffer[i]!;
        }
        return swapped.toString('utf16le');
      }
    }

    const decoders = [
      new TextDecoder('utf-8', { fatal: true }),
      new TextDecoder('gb18030', { fatal: true }),
      new TextDecoder('utf-16le', { fatal: true }),
    ];

    for (const decoder of decoders) {
      try {
        return decoder.decode(buffer);
      } catch {}
    }

    return buffer.toString('utf8');
  }

  private wrapExtractedText(content: string) {
    return ['<parsed_content>', this.truncateExtractedText(content, maxInjectedTextChars), '</parsed_content>'].join(
      '\n',
    );
  }

  private truncateExtractedText(content: string, limit: number) {
    const normalized = content.replace(/\u0000/g, '').trim();
    if (normalized.length <= limit) {
      return normalized;
    }
    return `${normalized.slice(0, limit)}\n[truncated]`;
  }

  private decodeXmlEntities(content: string) {
    return content
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  private createAttachmentFallbackBlock(
    fileName: string,
    filePath: string,
    mimeType: string,
    sizeBytes: number,
  ) {
    return [
      `[Attachment]`,
      `name: ${fileName}`,
      `path: ${filePath}`,
      `mime: ${mimeType || 'unknown'}`,
      `size_bytes: ${sizeBytes}`,
      `The file was uploaded, but no specialized parser is registered for this type.`,
    ].join('\n');
  }

  private resolveAttachmentDiskPath(
    userId: number,
    conversationId: string,
    attachment: MessageMedia,
  ) {
    const storedPath = this.pathWithoutQuery(
      attachment.storage_path ?? attachment.storagePath ?? attachment.url,
    );
    if (storedPath.startsWith('/api/career-agent/threads/')) {
      const fileName = storedPath.split('/').pop() ?? '';
      return join(conversationFilesRootDir, String(userId), conversationId, fileName);
    }

    const normalized = storedPath.replaceAll('\\', '/');
    const marker = '/src/Network/';
    const markerIndex = normalized.indexOf(marker);
    if (markerIndex >= 0) {
      const relative = normalized.slice(markerIndex + marker.length);
      return join(networkRootDir, relative);
    }

    if (normalized.startsWith('./src/Network/')) {
      return join(networkRootDir, normalized.replace('./src/Network/', ''));
    }

    return normalized;
  }

  private parseCreateSkillCommand(content: string) {
    const trimmed = content.trim();
    if (!trimmed.toLowerCase().startsWith('/create-skill')) {
      return null;
    }

    const args = trimmed.slice('/create-skill'.length).trim();
    if (!args) {
      throw new BadRequestException(
        'Usage: /create-skill {"name":"...","description":"...","content":"...","category":"utility","arguments":"arg1 arg2"}',
      );
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(args) as Record<string, unknown>;
    } catch {
      throw new BadRequestException(
        'Invalid /create-skill payload. Expected JSON like {"name":"...","description":"...","content":"..."}',
      );
    }

    const name = String(parsed.name ?? '').trim();
    const description = String(parsed.description ?? '').trim();
    const skillContent = String(parsed.content ?? '').trim();
    const category = String(parsed.category ?? 'utility').trim() || 'utility';
    const argumentNames =
      parsed.arguments === undefined || parsed.arguments === null
        ? undefined
        : String(parsed.arguments).trim();

    if (!name || !description || !skillContent) {
      throw new BadRequestException(
        'Invalid /create-skill payload. Fields "name", "description", and "content" are required.',
      );
    }

    return {
      name,
      description,
      content: skillContent,
      category,
      arguments: argumentNames,
    };
  }

  private sanitizeFileName(fileName: string) {
    const cleaned = fileName.trim().replace(/[^a-zA-Z0-9._-]/g, '_');
    return cleaned || `upload-${Date.now()}.bin`;
  }

  private resolveAssetKind(kind: SupportedUploadKind): 'image' | 'video' | 'file' {
    if (kind === 'image') {
      return 'image';
    }

    if (kind === 'video') {
      return 'video';
    }

    if (kind === 'text') {
      return 'file';
    }

    throw new UnsupportedMediaTypeException(`Unsupported upload kind: ${kind}`);
  }

  private toPublicFilePath(conversationId: string, storedFileName: string) {
    return `/api/career-agent/threads/${conversationId}/files/${storedFileName}`;
  }
  private toLocalFilePath(conversationId: string, storedFileName: string, userId: number) {
    return `./src/Network/files/${userId}/${conversationId}/${storedFileName}`;
  }
  private isEnoent(error: unknown) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    );
  }

  private toIsoString(value: string | Date | undefined) {
    if (!value) {
      return new Date().toISOString();
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    return new Date(value).toISOString();
  }
}
