export type ThreadStatus = 'active' | 'archived';

export interface ThreadSummary {
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
  status: ThreadStatus;
}

export type MessageRole = 'user' | 'assistant' | 'system';
export type MessageKind = 'markdown' | 'status';
export type LoadState = 'idle' | 'loading' | 'ready' | 'error';
export type AgentAccent = 'teal' | 'amber' | 'blue' | 'slate';
export type ArtifactStatus = 'idle' | 'loading' | 'streaming' | 'ready' | 'stale' | 'error';
export type ArtifactRenderMode = 'html' | 'markdown' | 'cards' | 'url';
export type ArtifactViewMode = 'pane' | 'focus' | 'immersive';
export type MessageActionKind = 'open-artifact';
export type MessageMediaKind = 'image' | 'audio' | 'video' | 'html' | 'app' | 'file';
export type DraftMessageAttachmentKind = 'image' | 'file';
export type SkillOutcome = 'success' | 'insufficient_input' | 'error';

export interface SkillResult {
  skillCallId: string;
  skillName: string;
  outcome: SkillOutcome;
  summary: string;
  result?: unknown;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  source: 'agent' | 'harness';
}

export interface AskQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  options: AskQuestionOption[];
  multiSelect: boolean;
}

export interface AskQuestionResponse {
  approved: boolean;
  answers?: Record<string, string>;
  annotations?: Record<string, { preview?: string; notes?: string }>;
}

export interface MessageAction {
  id: string;
  kind: MessageActionKind;
  label: string;
  artifactId: string;
  viewMode?: ArtifactViewMode;
}

export interface MessageMedia {
  id: string;
  kind: MessageMediaKind;
  url: string;
  title?: string;
  caption?: string;
  alt?: string;
  mimeType?: string;
  posterUrl?: string;
  artifactId?: string;
  downloadUrl?: string;
  storagePath?: string;
  sizeBytes?: number;
}

export interface MessageFileAttachment {
  id: string;
  name: string;
  url: string;
  mimeType?: string;
  sizeBytes?: number;
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
  questions?: AskQuestion[];
  answers?: Record<string, string>;
  media?: MessageMedia[];
  files?: MessageFileAttachment[];
  actions?: MessageAction[];
  raw?: Record<string, unknown> | null;
}

export interface DraftMessageAttachment {
  id: string;
  kind: DraftMessageAttachmentKind;
  name: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
}

export interface DraftMessageSubmission {
  content: string;
  attachments: DraftMessageAttachment[];
}

export interface UploadedConversationFile {
  assetId: string;
  kind: 'image' | 'video' | 'file';
  url: string;
  title: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  storagePath: string;
  storedFileName: string;
  originalName: string;
}

export interface SendThreadMessageInput {
  kind?: MessageKind;
  content: string;
  attachmentAssetIds?: string[];
  clientRequestId?: string;
  context?: Record<string, unknown>;
}

export interface SendThreadMessageResult {
  accepted: boolean;
  messageId: string;
  assistantMessageId: string;
  status: 'queued' | 'processing' | 'done' | 'failed' | string;
}

export type ThreadMessageStreamEvent =
  | {
      type: 'message.created';
      threadId: string;
      messageId: string;
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
      blockType: MessageBlockType;
      delta?: string;
      block?: MessageBlock;
    }
  | {
      type: 'message.block.completed';
      messageId: string;
      block: MessageBlock;
    }
  | ({
      type: 'skill.completed';
      messageId: string;
    } & SkillResult)
  | {
      type: 'artifact.created';
      messageId: string;
      actions?: MessageAction[];
      media?: MessageMedia[];
      files?: MessageFileAttachment[];
    }
  | {
      type: 'message.completed';
      accepted: boolean;
      status: SendThreadMessageResult['status'];
      threadId: string;
      messageId: string;
      assistantMessageId: string;
      reply: string;
      reasoning?: string | null;
      actions?: MessageAction[];
      media?: MessageMedia[];
      files?: MessageFileAttachment[];
      model?: string | null;
      usage?: Record<string, unknown> | null;
      stopReason?: string | null;
      blocks?: MessageBlock[];
      raw?: Record<string, unknown> | null;
    }
  | {
      type: 'error';
      message: string;
      code?: string;
    };

export interface ThreadMessage {
  id: string;
  threadId: string;
  role: MessageRole;
  kind: MessageKind;
  content: string;
  reasoning?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  agentAccent?: AgentAccent | null;
  actions?: MessageAction[];
  media?: MessageMedia[];
  files?: MessageFileAttachment[];
  uuid?: string | null;
  parentUuid?: string | null;
  sessionId?: string | null;
  model?: string | null;
  usage?: Record<string, unknown> | null;
  stopReason?: string | null;
  blocks?: MessageBlock[];
  raw?: Record<string, unknown> | null;
  streaming?: boolean;
  createdAt: string;
}

export interface ProfileRecord {
  schemaVersion: 'career_profile_v1';
  basicInfo: {
    fullName: string;
    displayName: string;
    contactEmail: string;
    phoneOrPreferredContact: string;
    currentCity: string;
    profileAssets: string[];
  };
  careerProfile: {
    candidateType: string;
    currentRole: string;
    employmentStatus: string;
    careerStage: string;
    educationBackground: string;
    workExperience: string;
    projectExperience: string;
    skills: string[];
    interests: string[];
    strengthTags: string[];
    weaknessTags: string[];
    personalityTraits: string[];
  };
  intentConstraints: {
    targetIndustry: string;
    targetIndustries: string[];
    targetRole: string;
    targetCity: string;
    expectedSalary: string;
    availableTime: string;
    jobSearchStatus: string;
    constraints: string[];
    workPreferences: string[];
    learningPreferences: string[];
    careerGoal: string;
  };
  activityRecords: {
    learningRecords: string[];
    projectRecords: string[];
    applicationRecords: string[];
    interviewRecords: string[];
    offerRecords: string[];
    workRecords: string[];
  };
  artifacts: {
    resumeSummary: string;
    portfolioLinks: string[];
    projectMaterials: string[];
    coverLetters: string[];
  };
  feedbackSignals: {
    userFeedback: string[];
    interviewFeedback: string[];
    mentorFeedback: string[];
    managerFeedback: string[];
    systemAssessmentFeedback: string[];
  };
  planState: {
    learningPlan: string;
    projectPlan: string;
    applicationPlan: string;
    interviewPlan: string;
    onboardingPlan: string;
    promotionPlan: string;
  };
  chinaResumeSupplement: {
    jobIntentionStatement: string;
    educationDetail: string;
    awardsCertificatesHighlights: string;
    conditionalFields: string;
  };
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? U[]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export interface ProfileSuggestion {
  rowId?: number;
  id: string;
  title: string;
  rationale: string;
  sourceThreadId: string | null;
  patch: DeepPartial<ProfileRecord>;
}

export type ArtifactType =
  | 'weekly-plan'
  | 'profile-summary'
  | 'career-roadmap'
  | 'mock-interview'
  | 'coding-assessment'
  | 'visual-learning'
  | 'app-example';

interface ArtifactRecordBase {
  id: string;
  type: ArtifactType;
  title: string;
  status: ArtifactStatus;
  revision: number;
  updatedAt: string;
  summary: string;
}

export interface HtmlArtifactRecord extends ArtifactRecordBase {
  renderMode: 'html';
  payload: {
    html: string;
    allowScripts?: boolean;
  };
}

export interface UrlArtifactRecord extends ArtifactRecordBase {
  renderMode: 'url';
  payload: {
    url: string;
  };
}

export interface MarkdownArtifactRecord extends ArtifactRecordBase {
  renderMode: 'markdown';
  payload: {
    markdown: string;
  };
}

export interface CardsArtifactRecord extends ArtifactRecordBase {
  renderMode: 'cards';
  payload: {
    cards: unknown[];
  };
}

export type ArtifactRecord =
  | HtmlArtifactRecord
  | UrlArtifactRecord
  | MarkdownArtifactRecord
  | CardsArtifactRecord;

export type ArtifactPayload = ArtifactRecord['payload'];

export interface AuthUser {
  id: string;
  publicUserId?: string;
  email: string | null;
  username: string | null;
  displayName: string;
}

export interface AuthSession {
  user: AuthUser;
  accessToken: string | null;
  refreshToken: string | null;
  tokenType: string;
  expiresAt: string | null;
  expiresIn: number | null;
}

export interface LoginCredentials {
  identifier: string;
  password: string;
}

export interface RegisterCredentials {
  email?: string;
  username?: string;
  displayName: string;
  password: string;
}

export interface AccountSetting {
  id: string;
  publicUserId?: string;
  email: string | null;
  username: string | null;
  displayName: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ApiSetting {
  id: string;
  userId: string;
  provider: string;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyHint: string | null;
  apiKeyFingerprint: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  imageUrl?: string | null;
  hasImageKey?: boolean;
  imageKeyHint?: string | null;
  imageDefaultModel?: string | null;
  imageModels?: string[];
  videoUrl?: string | null;
  hasVideoKey?: boolean;
  videoKeyHint?: string | null;
  videoDefaultModel?: string | null;
  videoModels?: string[];
}

export interface UserSettings {
  account: AccountSetting;
  apiSettings: ApiSetting[];
}

export interface UpdateUsernameInput {
  username: string;
  displayName?: string;
}

export interface UpsertApiSettingInput {
  provider?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  imageUrl?: string;
  imageKey?: string;
  imageDefaultModel?: string;
  imageModels?: string;
  videoUrl?: string;
  videoKey?: string;
  videoDefaultModel?: string;
  videoModels?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  status: number | null;
  message: string;
}

export type GithubMcpRuntimeStatus = 'not_configured' | 'disabled' | 'disconnected' | 'connecting' | 'connected' | 'failed';

export interface GithubMcpUser {
  login: string | null;
  name: string | null;
  id: string | null;
  htmlUrl: string | null;
}

export interface GithubMcpSetting {
  provider: 'github';
  endpoint: string;
  enabled: boolean;
  configured: boolean;
  tokenHint: string | null;
  status: GithubMcpRuntimeStatus;
  toolCount: number;
  toolNames: string[];
  githubUser: GithubMcpUser | null;
  lastError: string | null;
  connectedAt: string | null;
}

export interface GithubMcpTestResult {
  ok: boolean;
  status: GithubMcpRuntimeStatus;
  toolCount: number;
  toolNames: string[];
  githubUser: GithubMcpUser | null;
  message: string;
}

export interface UpdateGithubMcpSettingInput {
  enabled: boolean;
  personalAccessToken?: string;
}
