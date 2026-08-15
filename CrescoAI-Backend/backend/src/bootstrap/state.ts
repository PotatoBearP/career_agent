import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { Attributes, Meter, MetricOptions } from '@opentelemetry/api'
import type { logs } from '@opentelemetry/api-logs'
import type { LoggerProvider } from '@opentelemetry/sdk-logs'
import type { MeterProvider } from '@opentelemetry/sdk-metrics'
import type { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import { realpathSync } from 'fs'
import sumBy from 'lodash-es/sumBy.js'
import { cwd } from 'process'
import type { HookEvent, ModelUsage } from 'src/entrypoints/agentSdkTypes.js'
import type { AgentColorName } from 'src/tools/AgentTool/agentColorManager.js'
import type { HookCallbackMatcher } from 'src/types/hooks.js'
// Indirection for browser-sdk build (package.json "browser" field swaps
// crypto.ts for crypto.browser.ts). Pure leaf re-export of node:crypto —
// zero circular-dep risk. Path-alias import bypasses bootstrap-isolation
// (rule only checks ./ and / prefixes); explicit disable documents intent.
// eslint-disable-next-line custom-rules/bootstrap-isolation
import { randomUUID } from 'src/utils/crypto.js'
import type { ModelSetting } from 'src/utils/model/model.js'
import type { ModelStrings } from 'src/utils/model/modelStrings.js'
import type { SettingSource } from 'src/utils/settings/constants.js'
// NOTE: resetSettingsCache is imported lazily below to avoid circular dependency
// (state.ts -> settingsCache.ts -> state.ts). We inline the reset logic here instead.
import type { PluginHookMatcher } from 'src/utils/settings/types.js'
import { createSignal } from 'src/utils/signal.js'
import { getSessionContext } from '../server/SessionContext.js'

// Union type for registered hooks - can be SDK callbacks or native plugin hooks
type RegisteredHookMatcher = HookCallbackMatcher | PluginHookMatcher

import type { SessionId } from 'src/types/ids.js'
import type {
  SkillCompletedEvent,
  SkillInvocation,
} from 'src/skills/skillLifecycleTypes.js'

// DO NOT ADD MORE STATE HERE - BE JUDICIOUS WITH GLOBAL STATE

// dev: true on entries that came via --dangerously-load-development-channels.
// The allowlist gate checks this per-entry (not the session-wide
// hasDevChannels bit) so passing both flags doesn't let the dev dialog's
// acceptance leak allowlist-bypass to the --channels entries.
export type ChannelEntry =
  | { kind: 'plugin'; name: string; marketplace: string; dev?: boolean }
  | { kind: 'server'; name: string; dev?: boolean }

export type AttributedCounter = {
  add(value: number, additionalAttributes?: Attributes): void
}

type State = {
  originalCwd: string
  // Stable project root - set once at startup (including by --worktree flag),
  // never updated by mid-session EnterWorktreeTool.
  // Use for project identity (history, skills, sessions) not file operations.
  projectRoot: string
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  turnHookDurationMs: number
  turnToolDurationMs: number
  turnClassifierDurationMs: number
  turnToolCount: number
  turnHookCount: number
  turnClassifierCount: number
  startTime: number
  lastInteractionTime: number
  totalLinesAdded: number
  totalLinesRemoved: number
  hasUnknownModelCost: boolean
  cwd: string
  modelUsage: { [modelName: string]: ModelUsage }
  mainLoopModelOverride: ModelSetting | undefined
  initialMainLoopModel: ModelSetting
  modelStrings: ModelStrings | null
  isInteractive: boolean
  kairosActive: boolean
  // When true, ensureToolResultPairing throws on mismatch instead of
  // repairing with synthetic placeholders. HFI opts in at startup so
  // trajectories fail fast rather than conditioning the model on fake
  // tool_results.
  strictToolResultPairing: boolean
  sdkAgentProgressSummariesEnabled: boolean
  userMsgOptIn: boolean
  clientType: string
  sessionSource: string | undefined
  questionPreviewFormat: 'markdown' | 'html' | undefined
  flagSettingsPath: string | undefined
  flagSettingsInline: Record<string, unknown> | null
  allowedSettingSources: SettingSource[]
  sessionIngressToken: string | null | undefined
  oauthTokenFromFd: string | null | undefined
  apiKeyFromFd: string | null | undefined
  // Telemetry state
  meter: Meter | null
  sessionCounter: AttributedCounter | null
  locCounter: AttributedCounter | null
  prCounter: AttributedCounter | null
  commitCounter: AttributedCounter | null
  costCounter: AttributedCounter | null
  tokenCounter: AttributedCounter | null
  codeEditToolDecisionCounter: AttributedCounter | null
  activeTimeCounter: AttributedCounter | null
  statsStore: { observe(name: string, value: number): void } | null
  sessionId: SessionId
  // Parent session ID for tracking session lineage (e.g., plan mode -> implementation)
  parentSessionId: SessionId | undefined
  // Logger state
  loggerProvider: LoggerProvider | null
  eventLogger: ReturnType<typeof logs.getLogger> | null
  // Meter provider state
  meterProvider: MeterProvider | null
  // Tracer provider state
  tracerProvider: BasicTracerProvider | null
  // Agent color state
  agentColorMap: Map<string, AgentColorName>
  agentColorIndex: number
  // Last API request for bug reports
  lastAPIRequest: Omit<BetaMessageStreamParams, 'messages'> | null
  // Messages from the last API request (ant-only; reference, not clone).
  // Captures the exact post-compaction, CLAUDE.md-injected message set sent
  // to the API so /share's serialized_conversation.json reflects reality.
  lastAPIRequestMessages: BetaMessageStreamParams['messages'] | null
  // Last auto-mode classifier request(s) for /share transcript
  lastClassifierRequests: unknown[] | null
  // CLAUDE.md content cached by context.ts for the auto-mode classifier.
  // Breaks the yoloClassifier → claudemd → filesystem → permissions cycle.
  cachedClaudeMdContent: string | null
  // In-memory error log for recent errors
  inMemoryErrorLog: Array<{ error: string; timestamp: string }>
  // Session-only plugins from --plugin-dir flag
  inlinePlugins: Array<string>
  // Explicit --chrome / --no-chrome flag value (undefined = not set on CLI)
  chromeFlagOverride: boolean | undefined
  // Use cowork_plugins directory instead of plugins (--cowork flag or env var)
  useCoworkPlugins: boolean
  // Session-only bypass permissions mode flag (not persisted)
  sessionBypassPermissionsMode: boolean
  // Session-only flag gating the .claude/scheduled_tasks.json watcher
  // (useScheduledTasks). Set by cronScheduler.start() when the JSON has
  // entries, or by CronCreateTool. Not persisted.
  scheduledTasksEnabled: boolean
  // Session-only cron tasks created via CronCreate with durable: false.
  // Fire on schedule like file-backed tasks but are never written to
  // .claude/scheduled_tasks.json — they die with the process. Typed via
  // SessionCronTask below (not importing from cronTasks.ts keeps
  // bootstrap a leaf of the import DAG).
  sessionCronTasks: SessionCronTask[]
  // Teams created this session via TeamCreate. cleanupSessionTeams()
  // removes these on gracefulShutdown so subagent-created teams don't
  // persist on disk forever (gh-32730). TeamDelete removes entries to
  // avoid double-cleanup. Lives here (not teamHelpers.ts) so
  // resetStateForTests() clears it between tests.
  sessionCreatedTeams: Set<string>
  // Session-only trust flag for home directory (not persisted to disk)
  // When running from home dir, trust dialog is shown but not saved to disk.
  // This flag allows features requiring trust to work during the session.
  sessionTrustAccepted: boolean
  // Session-only flag to disable session persistence to disk
  sessionPersistenceDisabled: boolean
  // Track if user has exited plan mode in this session (for re-entry guidance)
  hasExitedPlanMode: boolean
  // Track if we need to show the plan mode exit attachment (one-time notification)
  needsPlanModeExitAttachment: boolean
  // Track if we need to show the auto mode exit attachment (one-time notification)
  needsAutoModeExitAttachment: boolean
  // Track if LSP plugin recommendation has been shown this session (only show once)
  lspRecommendationShownThisSession: boolean
  // SDK init event state - jsonSchema for structured output
  initJsonSchema: Record<string, unknown> | null
  // Registered hooks - SDK callbacks and plugin native hooks
  registeredHooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>> | null
  // Cache for plan slugs: sessionId -> wordSlug
  planSlugCache: Map<string, string>
  // Track teleported session for reliability logging
  teleportedSessionInfo: {
    isTeleported: boolean
    hasLoggedFirstMessage: boolean
    sessionId: string | null
  } | null
  // Track invoked skills for preservation across compaction
  // Keys are composite: `${agentId ?? ''}:${skillName}` to prevent cross-agent overwrites
  invokedSkills: Map<
    string,
    {
      skillName: string
      skillPath: string
      content: string
      invokedAt: number
      agentId: string | null
    }
  >
  // Invocation-level Prompt Skill lifecycle. This is runtime-only state and
  // is intentionally not restored when a process/session runtime is rebuilt.
  skillInvocations: Map<string, SkillInvocation>
  activeSkillCallStackByAgent: Map<string, string[]>
  pendingSkillLifecycleEvents: SkillCompletedEvent[]
  registeredSkillHookKeys: Set<string>
  // Track slow operations for dev bar display (ant-only)
  slowOperations: Array<{
    operation: string
    durationMs: number
    timestamp: number
  }>
  // SDK-provided betas (e.g., context-1m-2025-08-07)
  sdkBetas: string[] | undefined
  // Main thread agent type (from --agent flag or settings)
  mainThreadAgentType: string | undefined
  // Remote mode (--remote flag)
  isRemoteMode: boolean
  // Direct connect server URL (for display in header)
  directConnectServerUrl: string | undefined
  // System prompt section cache state
  systemPromptSectionCache: Map<string, string | null>
  // Last date emitted to the model (for detecting midnight date changes)
  lastEmittedDate: string | null
  // Additional directories from --add-dir flag (for CLAUDE.md loading)
  additionalDirectoriesForClaudeMd: string[]
  // Channel server allowlist from --channels flag (servers whose channel
  // notifications should register this session). Parsed once in main.tsx —
  // the tag decides trust model: 'plugin' → marketplace verification +
  // allowlist, 'server' → allowlist always fails (schema is plugin-only).
  // Either kind needs entry.dev to bypass allowlist.
  allowedChannels: ChannelEntry[]
  // True if any entry in allowedChannels came from
  // --dangerously-load-development-channels (so ChannelsNotice can name the
  // right flag in policy-blocked messages)
  hasDevChannels: boolean
  // Dir containing the session's `.jsonl`; null = derive from originalCwd.
  sessionProjectDir: string | null
  // User identity for multi-user session isolation (null in CLI mode)
  userId: string | null
  // Cached prompt cache 1h TTL allowlist from GrowthBook (session-stable)
  promptCache1hAllowlist: string[] | null
  // Cached 1h TTL user eligibility (session-stable). Latched on first
  // evaluation so mid-session overage flips don't change the cache_control
  // TTL, which would bust the server-side prompt cache.
  promptCache1hEligible: boolean | null
  // Sticky-on latch for AFK_MODE_BETA_HEADER. Once auto mode is first
  // activated, keep sending the header for the rest of the session so
  // Shift+Tab toggles don't bust the ~50-70K token prompt cache.
  afkModeHeaderLatched: boolean | null
  // Sticky-on latch for FAST_MODE_BETA_HEADER. Once fast mode is first
  // enabled, keep sending the header so cooldown enter/exit doesn't
  // double-bust the prompt cache. The `speed` body param stays dynamic.
  fastModeHeaderLatched: boolean | null
  // Sticky-on latch for the cache-editing beta header. Once cached
  // microcompact is first enabled, keep sending the header so mid-session
  // GrowthBook/settings toggles don't bust the prompt cache.
  cacheEditingHeaderLatched: boolean | null
  // Sticky-on latch for clearing thinking from prior tool loops. Triggered
  // when >1h since last API call (confirmed cache miss — no cache-hit
  // benefit to keeping thinking). Once latched, stays on so the newly-warmed
  // thinking-cleared cache isn't busted by flipping back to keep:'all'.
  thinkingClearLatched: boolean | null
  // Current prompt ID (UUID) correlating a user prompt with subsequent OTel events
  promptId: string | null
  // Last API requestId for the main conversation chain (not subagents).
  // Updated after each successful API response for main-session queries.
  // Read at shutdown to send cache eviction hints to inference.
  lastMainRequestId: string | undefined
  // Timestamp (Date.now()) of the last successful API call completion.
  // Used to compute timeSinceLastApiCallMs in tengu_api_success for
  // correlating cache misses with idle time (cache TTL is ~5min).
  lastApiCompletionTimestamp: number | null
  // Set to true after compaction (auto or manual /compact). Consumed by
  // logAPISuccess to tag the first post-compaction API call so we can
  // distinguish compaction-induced cache misses from TTL expiry.
  pendingPostCompaction: boolean
  // --- Per-session turn budget tracking (moved from module-level lets) ---
  outputTokensAtTurnStart: number
  currentTurnTokenBudget: number | null
  budgetContinuationCount: number
  // Per-session interaction time dirty flag
  interactionTimeDirty: boolean
  // --- Per-session stores (moved from module-level singletons for multi-user isolation) ---
  // History (history.ts)
  historyPendingEntries: Array<unknown>
  historyIsWriting: boolean
  historyFlushPromise: Promise<void> | null
  historyCleanupRegistered: boolean
  historyLastAddedEntry: unknown | null
  historySkippedTimestamps: Set<number>
  // Session env vars (sessionEnvVars.ts)
  sessionEnvVarsMap: Map<string, string>
  // Settings cache (settingsCache.ts)
  settingsSessionCache: unknown | null
  settingsPerSourceCache: Map<string, unknown>
  settingsParseFileCache: Map<string, unknown>
  settingsPluginBase: Record<string, unknown> | undefined
  // Agent transcript subdirs (sessionStorage.ts)
  agentTranscriptSubdirsMap: Map<string, string>
  // Context caches (context.ts) — per-session to avoid cross-user leakage
  contextGitStatusCache: string | null | undefined
  contextGitStatusPromise: Promise<string | null> | null
  contextSystemContextCache: Record<string, string> | null | undefined
  contextSystemContextPromise: Promise<Record<string, string>> | null
  contextUserContextCache: Record<string, string> | null | undefined
  contextUserContextPromise: Promise<Record<string, string>> | null
  // Image store cache (imageStore.ts)
  storedImagePathsMap: Map<number, string>
  // Message UUID dedup (print.ts)
  receivedMessageUuidsSet: Set<string>
  receivedMessageUuidsOrder: string[]
  // Classifier approvals (classifierApprovals.ts)
  classifierApprovalsMap: Map<string, unknown>
  classifierCheckingSet: Set<string>
  // Bash speculative checks (bashPermissions.ts)
  speculativeChecksMap: Map<string, Promise<unknown>>
  // File suggestions index (fileSuggestions.ts)
  fsFileIndex: unknown | null
  fsFileListRefreshPromise: Promise<unknown> | null
  fsCacheGeneration: number
  fsUntrackedFetchPromise: Promise<void> | null
  fsCachedTrackedFiles: string[]
  fsCachedConfigFiles: string[]
  fsCachedTrackedDirs: string[]
  fsIgnorePatternsCache: unknown | null
  fsIgnorePatternsCacheKey: string | null
  fsLastRefreshMs: number
  fsLastGitIndexMtime: number | null
  fsLoadedTrackedSignature: string | null
  fsLoadedMergedSignature: string | null
  fsIndexBuildCompleteSignal: unknown | null
  // --- Per-session state machine (sessionState.ts) ---
  ssCurrentState: 'idle' | 'running' | 'requires_action'
  ssHasPendingAction: boolean
  // --- Per-session start (sessionStart.ts) ---
  ssPendingInitialUserMessage: string | undefined
  // --- Per-session memory utils (sessionMemoryUtils.ts) ---
  smConfig: { minimumMessageTokensToInit: number; minimumTokensBetweenUpdate: number; toolCallsBetweenUpdates: number }
  smLastSummarizedMessageId: string | undefined
  smExtractionStartedAt: number | undefined
  smTokensAtLastExtraction: number
  smInitialized: boolean
  // --- Per-session memory (sessionMemory.ts) ---
  smLastMemoryMessageUuid: string | undefined
  smHasLoggedGateFailure: boolean
  // --- Per-session microcompact (microCompact.ts) ---
  mcCachedState: unknown | null
  mcPendingCacheEdits: unknown | null
  // --- Per-session extract memories (extractMemories.ts) ---
  emExtractor: unknown | null
  emDrainer: unknown | null
  // --- Per-session fast mode (fastMode.ts) ---
  fmRuntimeState: unknown
  fmOrgStatus: unknown
  fmHasLoggedCooldownExpiry: boolean
  fmLastPrefetchAt: number
  fmInflightPrefetch: Promise<void> | null
}

// ALSO HERE - THINK THRICE BEFORE MODIFYING
function getInitialState(): State {
  // Resolve symlinks in cwd to match behavior of shell.ts setCwd
  // This ensures consistency with how paths are sanitized for session storage
  let resolvedCwd = ''
  if (
    typeof process !== 'undefined' &&
    typeof process.cwd === 'function' &&
    typeof realpathSync === 'function'
  ) {
    const rawCwd = cwd()
    try {
      resolvedCwd = realpathSync(rawCwd).normalize('NFC')
    } catch {
      // File Provider EPERM on CloudStorage mounts (lstat per path component).
      resolvedCwd = rawCwd.normalize('NFC')
    }
  }
  const state: State = {
    originalCwd: resolvedCwd,
    projectRoot: resolvedCwd,
    totalCostUSD: 0,
    totalAPIDuration: 0,
    totalAPIDurationWithoutRetries: 0,
    totalToolDuration: 0,
    turnHookDurationMs: 0,
    turnToolDurationMs: 0,
    turnClassifierDurationMs: 0,
    turnToolCount: 0,
    turnHookCount: 0,
    turnClassifierCount: 0,
    startTime: Date.now(),
    lastInteractionTime: Date.now(),
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    hasUnknownModelCost: false,
    cwd: resolvedCwd,
    modelUsage: {},
    mainLoopModelOverride: undefined,
    initialMainLoopModel: null,
    modelStrings: null,
    isInteractive: false,
    kairosActive: false,
    strictToolResultPairing: false,
    sdkAgentProgressSummariesEnabled: false,
    userMsgOptIn: false,
    clientType: 'cli',
    sessionSource: undefined,
    questionPreviewFormat: undefined,
    sessionIngressToken: undefined,
    oauthTokenFromFd: undefined,
    apiKeyFromFd: undefined,
    flagSettingsPath: undefined,
    flagSettingsInline: null,
    allowedSettingSources: [
      'userSettings',
      'projectSettings',
      'localSettings',
      'flagSettings',
      'policySettings',
    ],
    // Telemetry state
    meter: null,
    sessionCounter: null,
    locCounter: null,
    prCounter: null,
    commitCounter: null,
    costCounter: null,
    tokenCounter: null,
    codeEditToolDecisionCounter: null,
    activeTimeCounter: null,
    statsStore: null,
    sessionId: randomUUID() as SessionId,
    parentSessionId: undefined,
    // Logger state
    loggerProvider: null,
    eventLogger: null,
    // Meter provider state
    meterProvider: null,
    tracerProvider: null,
    // Agent color state
    agentColorMap: new Map(),
    agentColorIndex: 0,
    // Last API request for bug reports
    lastAPIRequest: null,
    lastAPIRequestMessages: null,
    // Last auto-mode classifier request(s) for /share transcript
    lastClassifierRequests: null,
    cachedClaudeMdContent: null,
    // In-memory error log for recent errors
    inMemoryErrorLog: [],
    // Session-only plugins from --plugin-dir flag
    inlinePlugins: [],
    // Explicit --chrome / --no-chrome flag value (undefined = not set on CLI)
    chromeFlagOverride: undefined,
    // Use cowork_plugins directory instead of plugins
    useCoworkPlugins: false,
    // Session-only bypass permissions mode flag (not persisted)
    sessionBypassPermissionsMode: false,
    // Scheduled tasks disabled until flag or dialog enables them
    scheduledTasksEnabled: false,
    sessionCronTasks: [],
    sessionCreatedTeams: new Set(),
    // Session-only trust flag (not persisted to disk)
    sessionTrustAccepted: false,
    // Session-only flag to disable session persistence to disk
    sessionPersistenceDisabled: false,
    // Track if user has exited plan mode in this session
    hasExitedPlanMode: false,
    // Track if we need to show the plan mode exit attachment
    needsPlanModeExitAttachment: false,
    // Track if we need to show the auto mode exit attachment
    needsAutoModeExitAttachment: false,
    // Track if LSP plugin recommendation has been shown this session
    lspRecommendationShownThisSession: false,
    // SDK init event state
    initJsonSchema: null,
    registeredHooks: null,
    // Cache for plan slugs
    planSlugCache: new Map(),
    // Track teleported session for reliability logging
    teleportedSessionInfo: null,
    // Track invoked skills for preservation across compaction
    invokedSkills: new Map(),
    skillInvocations: new Map(),
    activeSkillCallStackByAgent: new Map(),
    pendingSkillLifecycleEvents: [],
    registeredSkillHookKeys: new Set(),
    // Track slow operations for dev bar display
    slowOperations: [],
    // SDK-provided betas
    sdkBetas: undefined,
    // Main thread agent type
    mainThreadAgentType: undefined,
    // Remote mode
    isRemoteMode: false,
    ...(process.env.USER_TYPE === 'ant'
      ? {
          replBridgeActive: false,
        }
      : {}),
    // Direct connect server URL
    directConnectServerUrl: undefined,
    // System prompt section cache state
    systemPromptSectionCache: new Map(),
    // Last date emitted to the model
    lastEmittedDate: null,
    // Additional directories from --add-dir flag (for CLAUDE.md loading)
    additionalDirectoriesForClaudeMd: [],
    // Channel server allowlist from --channels flag
    allowedChannels: [],
    hasDevChannels: false,
    // Session project dir (null = derive from originalCwd)
    sessionProjectDir: null,
    // User identity for multi-user isolation (null in CLI mode)
    userId: null,
    // Prompt cache 1h allowlist (null = not yet fetched from GrowthBook)
    promptCache1hAllowlist: null,
    // Prompt cache 1h eligibility (null = not yet evaluated)
    promptCache1hEligible: null,
    // Beta header latches (null = not yet triggered)
    afkModeHeaderLatched: null,
    fastModeHeaderLatched: null,
    cacheEditingHeaderLatched: null,
    thinkingClearLatched: null,
    // Current prompt ID
    promptId: null,
    lastMainRequestId: undefined,
    lastApiCompletionTimestamp: null,
    pendingPostCompaction: false,
    // Per-session turn budget tracking
    outputTokensAtTurnStart: 0,
    currentTurnTokenBudget: null,
    budgetContinuationCount: 0,
    // Per-session interaction time dirty flag
    interactionTimeDirty: false,
    // Per-session stores (multi-user isolation)
    historyPendingEntries: [],
    historyIsWriting: false,
    historyFlushPromise: null,
    historyCleanupRegistered: false,
    historyLastAddedEntry: null,
    historySkippedTimestamps: new Set(),
    sessionEnvVarsMap: new Map(),
    settingsSessionCache: null,
    settingsPerSourceCache: new Map(),
    settingsParseFileCache: new Map(),
    settingsPluginBase: undefined,
    agentTranscriptSubdirsMap: new Map(),
    // Context caches (context.ts)
    contextGitStatusCache: undefined,
    contextGitStatusPromise: null,
    contextSystemContextCache: undefined,
    contextSystemContextPromise: null,
    contextUserContextCache: undefined,
    contextUserContextPromise: null,
    // Image store cache (imageStore.ts)
    storedImagePathsMap: new Map(),
    // Message UUID dedup (print.ts)
    receivedMessageUuidsSet: new Set(),
    receivedMessageUuidsOrder: [],
    // Classifier approvals (classifierApprovals.ts)
    classifierApprovalsMap: new Map(),
    classifierCheckingSet: new Set(),
    // Bash speculative checks (bashPermissions.ts)
    speculativeChecksMap: new Map(),
    // File suggestions index (fileSuggestions.ts)
    fsFileIndex: null,
    fsFileListRefreshPromise: null,
    fsCacheGeneration: 0,
    fsUntrackedFetchPromise: null,
    fsCachedTrackedFiles: [],
    fsCachedConfigFiles: [],
    fsCachedTrackedDirs: [],
    fsIgnorePatternsCache: null,
    fsIgnorePatternsCacheKey: null,
    fsLastRefreshMs: 0,
    fsLastGitIndexMtime: null,
    fsLoadedTrackedSignature: null,
    fsLoadedMergedSignature: null,
    fsIndexBuildCompleteSignal: null,
    // Per-session state machine (sessionState.ts)
    ssCurrentState: 'idle',
    ssHasPendingAction: false,
    // Per-session start (sessionStart.ts)
    ssPendingInitialUserMessage: undefined,
    // Per-session memory utils (sessionMemoryUtils.ts)
    smConfig: { minimumMessageTokensToInit: 10000, minimumTokensBetweenUpdate: 5000, toolCallsBetweenUpdates: 3 },
    smLastSummarizedMessageId: undefined,
    smExtractionStartedAt: undefined,
    smTokensAtLastExtraction: 0,
    smInitialized: false,
    // Per-session memory (sessionMemory.ts)
    smLastMemoryMessageUuid: undefined,
    smHasLoggedGateFailure: false,
    // Per-session microcompact (microCompact.ts)
    mcCachedState: null,
    mcPendingCacheEdits: null,
    // Per-session extract memories (extractMemories.ts)
    emExtractor: null,
    emDrainer: null,
    // Per-session fast mode (fastMode.ts)
    fmRuntimeState: { status: 'active' },
    fmOrgStatus: { status: 'pending' },
    fmHasLoggedCooldownExpiry: false,
    fmLastPrefetchAt: 0,
    fmInflightPrefetch: null,
  }

  return state
}

// AND ESPECIALLY HERE
const STATE: State = getInitialState()

export function createIsolatedState(overrides: Partial<State> = {}): State {
  const state = getInitialState()
  return { ...state, ...overrides }
}

/**
 * Returns the per-session state when running inside an ALS context (server mode),
 * or the global STATE singleton otherwise (CLI mode).
 *
 * Every accessor function in this module should call getState() instead of
 * reading STATE directly so that multi-user server sessions get isolated state.
 */
export function getState(): State {
  const ctx = getSessionContext()
  return ctx ? ctx.state : STATE
}

export function getSessionId(): SessionId {
  const ctx = getSessionContext()
  if (ctx) return ctx.state.sessionId
  return STATE.sessionId
}

export function regenerateSessionId(
  options: { setCurrentAsParent?: boolean } = {},
): SessionId {
  const s = getState()
  if (options.setCurrentAsParent) {
    s.parentSessionId = s.sessionId
  }
  // Drop the outgoing session's plan-slug entry so the Map doesn't
  // accumulate stale keys. Callers that need to carry the slug across
  // (REPL.tsx clearContext) read it before calling clearConversation.
  s.planSlugCache.delete(s.sessionId)
  // Regenerated sessions live in the current project: reset projectDir to
  // null so getTranscriptPath() derives from originalCwd.
  s.sessionId = randomUUID() as SessionId
  s.sessionProjectDir = null
  return s.sessionId
}

export function getParentSessionId(): SessionId | undefined {
  return getState().parentSessionId
}

/**
 * Atomically switch the active session. `sessionId` and `sessionProjectDir`
 * always change together — there is no separate setter for either, so they
 * cannot drift out of sync (CC-34).
 *
 * @param projectDir — directory containing `<sessionId>.jsonl`. Omit (or
 *   pass `null`) for sessions in the current project — the path will derive
 *   from originalCwd at read time. Pass `dirname(transcriptPath)` when the
 *   session lives in a different project directory (git worktrees,
 *   cross-project resume). Every call resets the project dir; it never
 *   carries over from the previous session.
 */
export function switchSession(
  sessionId: SessionId,
  projectDir: string | null = null,
): void {
  const ctx = getSessionContext()
  if (ctx) {
    // Server mode: route to per-session state and signal
    ctx.state.planSlugCache.delete(ctx.state.sessionId)
    ctx.state.sessionId = sessionId
    ctx.state.sessionProjectDir = projectDir
    ctx.sessionSwitched.emit(sessionId)
  } else {
    // CLI mode: use global STATE and signal
    STATE.planSlugCache.delete(STATE.sessionId)
    STATE.sessionId = sessionId
    STATE.sessionProjectDir = projectDir
    sessionSwitched.emit(sessionId)
  }
}

// Module-level signal for CLI mode (single user)
const sessionSwitched = createSignal<[id: SessionId]>()

/**
 * Register a callback that fires when switchSession changes the active
 * sessionId. bootstrap can't import listeners directly (DAG leaf), so
 * callers register themselves. concurrentSessions.ts uses this to keep the
 * PID file's sessionId in sync with --resume.
 *
 * In server mode, this subscribes to the per-session signal in the current
 * ALS context. In CLI mode, it subscribes to the global signal.
 */
export function onSessionSwitch(
  listener: (id: SessionId) => void,
): () => void {
  const ctx = getSessionContext()
  if (ctx) {
    return ctx.sessionSwitched.subscribe(listener)
  }
  return sessionSwitched.subscribe(listener)
}

/**
 * Project directory the current session's transcript lives in, or `null` if
 * the session was created in the current project (common case — derive from
 * originalCwd). See `switchSession()`.
 */
export function getSessionProjectDir(): string | null {
  return getState().sessionProjectDir
}

/**
 * Get the current user identity for session isolation.
 * Returns null in CLI mode (no user scoping).
 * In server mode, returns the userId set during session creation.
 */
export function getUserId(): string | null {
  return getState().userId
}

export function getOriginalCwd(): string {
  return getState().originalCwd
}

/**
 * Get the stable project root directory.
 * Unlike getOriginalCwd(), this is never updated by mid-session EnterWorktreeTool
 * (so skills/history stay stable when entering a throwaway worktree).
 * It IS set at startup by --worktree, since that worktree is the session's project.
 * Use for project identity (history, skills, sessions) not file operations.
 */
export function getProjectRoot(): string {
  return getState().projectRoot
}

export function setOriginalCwd(cwd: string): void {
  getState().originalCwd = cwd.normalize('NFC')
}

/**
 * Only for --worktree startup flag. Mid-session EnterWorktreeTool must NOT
 * call this — skills/history should stay anchored to where the session started.
 */
export function setProjectRoot(cwd: string): void {
  getState().projectRoot = cwd.normalize('NFC')
}

export function getCwdState(): string {
  return getState().cwd
}

export function setCwdState(cwd: string): void {
  getState().cwd = cwd.normalize('NFC')
}

export function getDirectConnectServerUrl(): string | undefined {
  return getState().directConnectServerUrl
}

export function setDirectConnectServerUrl(url: string): void {
  getState().directConnectServerUrl = url
}

export function addToTotalDurationState(
  duration: number,
  durationWithoutRetries: number,
): void {
  const s = getState()
  s.totalAPIDuration += duration
  s.totalAPIDurationWithoutRetries += durationWithoutRetries
}

export function resetTotalDurationStateAndCost_FOR_TESTS_ONLY(): void {
  const s = getState()
  s.totalAPIDuration = 0
  s.totalAPIDurationWithoutRetries = 0
  s.totalCostUSD = 0
}

export function addToTotalCostState(
  cost: number,
  modelUsage: ModelUsage,
  model: string,
): void {
  const s = getState()
  s.modelUsage[model] = modelUsage
  s.totalCostUSD += cost
}

export function getTotalCostUSD(): number {
  return getState().totalCostUSD
}

export function getTotalAPIDuration(): number {
  return getState().totalAPIDuration
}

export function getTotalDuration(): number {
  return Date.now() - getState().startTime
}

export function getTotalAPIDurationWithoutRetries(): number {
  return getState().totalAPIDurationWithoutRetries
}

export function getTotalToolDuration(): number {
  return getState().totalToolDuration
}

export function addToToolDuration(duration: number): void {
  const s = getState()
  s.totalToolDuration += duration
  s.turnToolDurationMs += duration
  s.turnToolCount++
}

export function getTurnHookDurationMs(): number {
  return getState().turnHookDurationMs
}

export function addToTurnHookDuration(duration: number): void {
  const s = getState()
  s.turnHookDurationMs += duration
  s.turnHookCount++
}

export function resetTurnHookDuration(): void {
  const s = getState()
  s.turnHookDurationMs = 0
  s.turnHookCount = 0
}

export function getTurnHookCount(): number {
  return getState().turnHookCount
}

export function getTurnToolDurationMs(): number {
  return getState().turnToolDurationMs
}

export function resetTurnToolDuration(): void {
  const s = getState()
  s.turnToolDurationMs = 0
  s.turnToolCount = 0
}

export function getTurnToolCount(): number {
  return getState().turnToolCount
}

export function getTurnClassifierDurationMs(): number {
  return getState().turnClassifierDurationMs
}

export function addToTurnClassifierDuration(duration: number): void {
  const s = getState()
  s.turnClassifierDurationMs += duration
  s.turnClassifierCount++
}

export function resetTurnClassifierDuration(): void {
  const s = getState()
  s.turnClassifierDurationMs = 0
  s.turnClassifierCount = 0
}

export function getTurnClassifierCount(): number {
  return getState().turnClassifierCount
}

export function getStatsStore(): {
  observe(name: string, value: number): void
} | null {
  return getState().statsStore
}

export function setStatsStore(
  store: { observe(name: string, value: number): void } | null,
): void {
  getState().statsStore = store
}

/**
 * Marks that an interaction occurred.
 *
 * By default the actual Date.now() call is deferred until the next Ink render
 * frame (via flushInteractionTime()) so we avoid calling Date.now() on every
 * single keypress.
 *
 * Pass `immediate = true` when calling from React useEffect callbacks or
 * other code that runs *after* the Ink render cycle has already flushed.
 * Without it the timestamp stays stale until the next render, which may never
 * come if the user is idle (e.g. permission dialog waiting for input).
 */
export function updateLastInteractionTime(immediate?: boolean): void {
  if (immediate) {
    flushInteractionTime_inner()
  } else {
    getState().interactionTimeDirty = true
  }
}

/**
 * If an interaction was recorded since the last flush, update the timestamp
 * now. Called by Ink before each render cycle so we batch many keypresses into
 * a single Date.now() call.
 */
export function flushInteractionTime(): void {
  if (getState().interactionTimeDirty) {
    flushInteractionTime_inner()
  }
}

function flushInteractionTime_inner(): void {
  const s = getState()
  s.lastInteractionTime = Date.now()
  s.interactionTimeDirty = false
}

export function addToTotalLinesChanged(added: number, removed: number): void {
  const s = getState()
  s.totalLinesAdded += added
  s.totalLinesRemoved += removed
}

export function getTotalLinesAdded(): number {
  return getState().totalLinesAdded
}

export function getTotalLinesRemoved(): number {
  return getState().totalLinesRemoved
}

export function getTotalInputTokens(): number {
  return sumBy(Object.values(getState().modelUsage), 'inputTokens')
}

export function getTotalOutputTokens(): number {
  return sumBy(Object.values(getState().modelUsage), 'outputTokens')
}

export function getTotalCacheReadInputTokens(): number {
  return sumBy(Object.values(getState().modelUsage), 'cacheReadInputTokens')
}

export function getTotalCacheCreationInputTokens(): number {
  return sumBy(Object.values(getState().modelUsage), 'cacheCreationInputTokens')
}

export function getTotalWebSearchRequests(): number {
  return sumBy(Object.values(getState().modelUsage), 'webSearchRequests')
}

export function getTurnOutputTokens(): number {
  return getTotalOutputTokens() - getState().outputTokensAtTurnStart
}
export function getCurrentTurnTokenBudget(): number | null {
  return getState().currentTurnTokenBudget
}
export function snapshotOutputTokensForTurn(budget: number | null): void {
  const s = getState()
  s.outputTokensAtTurnStart = getTotalOutputTokens()
  s.currentTurnTokenBudget = budget
  s.budgetContinuationCount = 0
}
export function getBudgetContinuationCount(): number {
  return getState().budgetContinuationCount
}
export function incrementBudgetContinuationCount(): void {
  getState().budgetContinuationCount++
}

export function setHasUnknownModelCost(): void {
  getState().hasUnknownModelCost = true
}

export function hasUnknownModelCost(): boolean {
  return getState().hasUnknownModelCost
}

export function getLastMainRequestId(): string | undefined {
  return getState().lastMainRequestId
}

export function setLastMainRequestId(requestId: string): void {
  getState().lastMainRequestId = requestId
}

export function getLastApiCompletionTimestamp(): number | null {
  return getState().lastApiCompletionTimestamp
}

export function setLastApiCompletionTimestamp(timestamp: number): void {
  getState().lastApiCompletionTimestamp = timestamp
}

/** Mark that a compaction just occurred. The next API success event will
 *  include isPostCompaction=true, then the flag auto-resets. */
export function markPostCompaction(): void {
  getState().pendingPostCompaction = true
}

/** Consume the post-compaction flag. Returns true once after compaction,
 *  then returns false until the next compaction. */
export function consumePostCompaction(): boolean {
  const s = getState()
  const was = s.pendingPostCompaction
  s.pendingPostCompaction = false
  return was
}

export function getLastInteractionTime(): number {
  return getState().lastInteractionTime
}

// Scroll drain suspension — background intervals check this before doing work
// so they don't compete with scroll frames for the event loop. Set by
// ScrollBox scrollBy/scrollTo, cleared SCROLL_DRAIN_IDLE_MS after the last
// scroll event. Module-scope (not in STATE) — ephemeral hot-path flag, no
// test-reset needed since the debounce timer self-clears.
let scrollDraining = false
let scrollDrainTimer: ReturnType<typeof setTimeout> | undefined
const SCROLL_DRAIN_IDLE_MS = 150

/** Mark that a scroll event just happened. Background intervals gate on
 *  getIsScrollDraining() and skip their work until the debounce clears. */
export function markScrollActivity(): void {
  scrollDraining = true
  if (scrollDrainTimer) clearTimeout(scrollDrainTimer)
  scrollDrainTimer = setTimeout(() => {
    scrollDraining = false
    scrollDrainTimer = undefined
  }, SCROLL_DRAIN_IDLE_MS)
  scrollDrainTimer.unref?.()
}

/** True while scroll is actively draining (within 150ms of last event).
 *  Intervals should early-return when this is set — the work picks up next
 *  tick after scroll settles. */
export function getIsScrollDraining(): boolean {
  return scrollDraining
}

/** Await this before expensive one-shot work (network, subprocess) that could
 *  coincide with scroll. Resolves immediately if not scrolling; otherwise
 *  polls at the idle interval until the flag clears. */
export async function waitForScrollIdle(): Promise<void> {
  while (scrollDraining) {
    // bootstrap-isolation forbids importing sleep() from src/utils/
    // eslint-disable-next-line no-restricted-syntax
    await new Promise(r => setTimeout(r, SCROLL_DRAIN_IDLE_MS).unref?.())
  }
}

export function getModelUsage(): { [modelName: string]: ModelUsage } {
  return getState().modelUsage
}

export function getUsageForModel(model: string): ModelUsage | undefined {
  return getState().modelUsage[model]
}

/**
 * Gets the model override set from the --model CLI flag or after the user
 * updates their configured model.
 */
export function getMainLoopModelOverride(): ModelSetting | undefined {
  return getState().mainLoopModelOverride
}

export function getInitialMainLoopModel(): ModelSetting {
  return getState().initialMainLoopModel
}

export function setMainLoopModelOverride(
  model: ModelSetting | undefined,
): void {
  getState().mainLoopModelOverride = model
}

export function setInitialMainLoopModel(model: ModelSetting): void {
  getState().initialMainLoopModel = model
}

export function getSdkBetas(): string[] | undefined {
  return getState().sdkBetas
}

export function setSdkBetas(betas: string[] | undefined): void {
  getState().sdkBetas = betas
}

export function resetCostState(): void {
  const s = getState()
  s.totalCostUSD = 0
  s.totalAPIDuration = 0
  s.totalAPIDurationWithoutRetries = 0
  s.totalToolDuration = 0
  s.startTime = Date.now()
  s.totalLinesAdded = 0
  s.totalLinesRemoved = 0
  s.hasUnknownModelCost = false
  s.modelUsage = {}
  s.promptId = null
}

/**
 * Sets cost state values for session restore.
 * Called by restoreCostStateForSession in cost-tracker.ts.
 */
export function setCostStateForRestore({
  totalCostUSD,
  totalAPIDuration,
  totalAPIDurationWithoutRetries,
  totalToolDuration,
  totalLinesAdded,
  totalLinesRemoved,
  lastDuration,
  modelUsage,
}: {
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  lastDuration: number | undefined
  modelUsage: { [modelName: string]: ModelUsage } | undefined
}): void {
  const s = getState()
  s.totalCostUSD = totalCostUSD
  s.totalAPIDuration = totalAPIDuration
  s.totalAPIDurationWithoutRetries = totalAPIDurationWithoutRetries
  s.totalToolDuration = totalToolDuration
  s.totalLinesAdded = totalLinesAdded
  s.totalLinesRemoved = totalLinesRemoved

  // Restore per-model usage breakdown
  if (modelUsage) {
    s.modelUsage = modelUsage
  }

  // Adjust startTime to make wall duration accumulate
  if (lastDuration) {
    s.startTime = Date.now() - lastDuration
  }
}

// Only used in tests
export function resetStateForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetStateForTests can only be called in tests')
  }
  Object.entries(getInitialState()).forEach(([key, value]) => {
    STATE[key as keyof State] = value as never
  })
  sessionSwitched.clear()
}

// You shouldn't use this directly. See src/utils/model/modelStrings.ts::getModelStrings()
export function getModelStrings(): ModelStrings | null {
  return getState().modelStrings
}

// You shouldn't use this directly. See src/utils/model/modelStrings.ts
export function setModelStrings(modelStrings: ModelStrings): void {
  getState().modelStrings = modelStrings
}

// Test utility function to reset model strings for re-initialization.
// Separate from setModelStrings because we only want to accept 'null' in tests.
export function resetModelStringsForTestingOnly() {
  getState().modelStrings = null
}

export function setMeter(
  meter: Meter,
  createCounter: (name: string, options: MetricOptions) => AttributedCounter,
): void {
  const s = getState()
  s.meter = meter

  // Initialize all counters using the provided factory
  s.sessionCounter = createCounter('claude_code.session.count', {
    description: 'Count of CLI sessions started',
  })
  s.locCounter = createCounter('claude_code.lines_of_code.count', {
    description:
      "Count of lines of code modified, with the 'type' attribute indicating whether lines were added or removed",
  })
  s.prCounter = createCounter('claude_code.pull_request.count', {
    description: 'Number of pull requests created',
  })
  s.commitCounter = createCounter('claude_code.commit.count', {
    description: 'Number of git commits created',
  })
  s.costCounter = createCounter('claude_code.cost.usage', {
    description: 'Cost of the Claude Code session',
    unit: 'USD',
  })
  s.tokenCounter = createCounter('claude_code.token.usage', {
    description: 'Number of tokens used',
    unit: 'tokens',
  })
  s.codeEditToolDecisionCounter = createCounter(
    'claude_code.code_edit_tool.decision',
    {
      description:
        'Count of code editing tool permission decisions (accept/reject) for Edit, Write, and NotebookEdit tools',
    },
  )
  s.activeTimeCounter = createCounter('claude_code.active_time.total', {
    description: 'Total active time in seconds',
    unit: 's',
  })
}

export function getMeter(): Meter | null {
  return getState().meter
}

export function getSessionCounter(): AttributedCounter | null {
  return getState().sessionCounter
}

export function getLocCounter(): AttributedCounter | null {
  return getState().locCounter
}

export function getPrCounter(): AttributedCounter | null {
  return getState().prCounter
}

export function getCommitCounter(): AttributedCounter | null {
  return getState().commitCounter
}

export function getCostCounter(): AttributedCounter | null {
  return getState().costCounter
}

export function getTokenCounter(): AttributedCounter | null {
  return getState().tokenCounter
}

export function getCodeEditToolDecisionCounter(): AttributedCounter | null {
  return getState().codeEditToolDecisionCounter
}

export function getActiveTimeCounter(): AttributedCounter | null {
  return getState().activeTimeCounter
}

export function getLoggerProvider(): LoggerProvider | null {
  return getState().loggerProvider
}

export function setLoggerProvider(provider: LoggerProvider | null): void {
  getState().loggerProvider = provider
}

export function getEventLogger(): ReturnType<typeof logs.getLogger> | null {
  return getState().eventLogger
}

export function setEventLogger(
  logger: ReturnType<typeof logs.getLogger> | null,
): void {
  getState().eventLogger = logger
}

export function getMeterProvider(): MeterProvider | null {
  return getState().meterProvider
}

export function setMeterProvider(provider: MeterProvider | null): void {
  getState().meterProvider = provider
}
export function getTracerProvider(): BasicTracerProvider | null {
  return getState().tracerProvider
}
export function setTracerProvider(provider: BasicTracerProvider | null): void {
  getState().tracerProvider = provider
}

export function getIsNonInteractiveSession(): boolean {
  return !getState().isInteractive
}

export function getIsInteractive(): boolean {
  return getState().isInteractive
}

export function setIsInteractive(value: boolean): void {
  getState().isInteractive = value
}

/**
 * Check if running in headless mode (no Ink UI rendering).
 * In server mode (when ALS context exists), SessionContext.isHeadless is always true.
 * In CLI mode, headless when non-interactive (print/-p mode).
 */
export function getIsHeadless(): boolean {
  return !getState().isInteractive
}

export function getClientType(): string {
  return getState().clientType
}

export function setClientType(type: string): void {
  getState().clientType = type
}

export function getSdkAgentProgressSummariesEnabled(): boolean {
  return getState().sdkAgentProgressSummariesEnabled
}

export function setSdkAgentProgressSummariesEnabled(value: boolean): void {
  getState().sdkAgentProgressSummariesEnabled = value
}

export function getKairosActive(): boolean {
  return getState().kairosActive
}

export function setKairosActive(value: boolean): void {
  getState().kairosActive = value
}

export function getStrictToolResultPairing(): boolean {
  return getState().strictToolResultPairing
}

export function setStrictToolResultPairing(value: boolean): void {
  getState().strictToolResultPairing = value
}

// Field name 'userMsgOptIn' avoids excluded-string substrings ('BriefTool',
// 'SendUserMessage' — case-insensitive). All callers are inside feature()
// guards so these accessors don't need their own (matches getKairosActive).
export function getUserMsgOptIn(): boolean {
  return getState().userMsgOptIn
}

export function setUserMsgOptIn(value: boolean): void {
  getState().userMsgOptIn = value
}

export function getSessionSource(): string | undefined {
  return getState().sessionSource
}

export function setSessionSource(source: string): void {
  getState().sessionSource = source
}

export function getQuestionPreviewFormat(): 'markdown' | 'html' | undefined {
  return getState().questionPreviewFormat
}

export function setQuestionPreviewFormat(format: 'markdown' | 'html'): void {
  getState().questionPreviewFormat = format
}

export function getAgentColorMap(): Map<string, AgentColorName> {
  return getState().agentColorMap
}

export function getFlagSettingsPath(): string | undefined {
  return getState().flagSettingsPath
}

export function setFlagSettingsPath(path: string | undefined): void {
  getState().flagSettingsPath = path
}

export function getFlagSettingsInline(): Record<string, unknown> | null {
  return getState().flagSettingsInline
}

export function setFlagSettingsInline(
  settings: Record<string, unknown> | null,
): void {
  getState().flagSettingsInline = settings
}

export function getSessionIngressToken(): string | null | undefined {
  return getState().sessionIngressToken
}

export function setSessionIngressToken(token: string | null): void {
  getState().sessionIngressToken = token
}

export function getOauthTokenFromFd(): string | null | undefined {
  return getState().oauthTokenFromFd
}

export function setOauthTokenFromFd(token: string | null): void {
  getState().oauthTokenFromFd = token
}

export function getApiKeyFromFd(): string | null | undefined {
  return getState().apiKeyFromFd
}

export function setApiKeyFromFd(key: string | null): void {
  getState().apiKeyFromFd = key
}

export function setLastAPIRequest(
  params: Omit<BetaMessageStreamParams, 'messages'> | null,
): void {
  getState().lastAPIRequest = params
}

export function getLastAPIRequest(): Omit<
  BetaMessageStreamParams,
  'messages'
> | null {
  return getState().lastAPIRequest
}

export function setLastAPIRequestMessages(
  messages: BetaMessageStreamParams['messages'] | null,
): void {
  getState().lastAPIRequestMessages = messages
}

export function getLastAPIRequestMessages():
  | BetaMessageStreamParams['messages']
  | null {
  return getState().lastAPIRequestMessages
}

export function setLastClassifierRequests(requests: unknown[] | null): void {
  getState().lastClassifierRequests = requests
}

export function getLastClassifierRequests(): unknown[] | null {
  return getState().lastClassifierRequests
}

export function setCachedClaudeMdContent(content: string | null): void {
  getState().cachedClaudeMdContent = content
}

export function getCachedClaudeMdContent(): string | null {
  return getState().cachedClaudeMdContent
}

export function addToInMemoryErrorLog(errorInfo: {
  error: string
  timestamp: string
}): void {
  const s = getState()
  const MAX_IN_MEMORY_ERRORS = 100
  if (s.inMemoryErrorLog.length >= MAX_IN_MEMORY_ERRORS) {
    s.inMemoryErrorLog.shift() // Remove oldest error
  }
  s.inMemoryErrorLog.push(errorInfo)
}

export function getAllowedSettingSources(): SettingSource[] {
  return getState().allowedSettingSources
}

export function setAllowedSettingSources(sources: SettingSource[]): void {
  getState().allowedSettingSources = sources
}

export function preferThirdPartyAuthentication(): boolean {
  // IDE extension should behave as 1P for authentication reasons.
  return getIsNonInteractiveSession() && getState().clientType !== 'claude-vscode'
}

export function setInlinePlugins(plugins: Array<string>): void {
  getState().inlinePlugins = plugins
}

export function getInlinePlugins(): Array<string> {
  return getState().inlinePlugins
}

export function setChromeFlagOverride(value: boolean | undefined): void {
  getState().chromeFlagOverride = value
}

export function getChromeFlagOverride(): boolean | undefined {
  return getState().chromeFlagOverride
}

export function setUseCoworkPlugins(value: boolean): void {
  getState().useCoworkPlugins = value
  // Inline resetSettingsCache to avoid circular dependency
  const s = getState()
  s.settingsSessionCache = null
  s.settingsPerSourceCache.clear()
  s.settingsParseFileCache.clear()
}

export function getUseCoworkPlugins(): boolean {
  return getState().useCoworkPlugins
}

export function setSessionBypassPermissionsMode(enabled: boolean): void {
  getState().sessionBypassPermissionsMode = enabled
}

export function getSessionBypassPermissionsMode(): boolean {
  return getState().sessionBypassPermissionsMode
}

export function setScheduledTasksEnabled(enabled: boolean): void {
  getState().scheduledTasksEnabled = enabled
}

export function getScheduledTasksEnabled(): boolean {
  return getState().scheduledTasksEnabled
}

export type SessionCronTask = {
  id: string
  cron: string
  prompt: string
  createdAt: number
  recurring?: boolean
  /**
   * When set, the task was created by an in-process teammate (not the team lead).
   * The scheduler routes fires to that teammate's pendingUserMessages queue
   * instead of the main REPL command queue. Session-only — never written to disk.
   */
  agentId?: string
}

export function getSessionCronTasks(): SessionCronTask[] {
  return getState().sessionCronTasks
}

export function addSessionCronTask(task: SessionCronTask): void {
  getState().sessionCronTasks.push(task)
}

/**
 * Returns the number of tasks actually removed. Callers use this to skip
 * downstream work (e.g. the disk read in removeCronTasks) when all ids
 * were accounted for here.
 */
export function removeSessionCronTasks(ids: readonly string[]): number {
  if (ids.length === 0) return 0
  const s = getState()
  const idSet = new Set(ids)
  const remaining = s.sessionCronTasks.filter(t => !idSet.has(t.id))
  const removed = s.sessionCronTasks.length - remaining.length
  if (removed === 0) return 0
  s.sessionCronTasks = remaining
  return removed
}

export function setSessionTrustAccepted(accepted: boolean): void {
  getState().sessionTrustAccepted = accepted
}

export function getSessionTrustAccepted(): boolean {
  return getState().sessionTrustAccepted
}

export function setSessionPersistenceDisabled(disabled: boolean): void {
  getState().sessionPersistenceDisabled = disabled
}

export function isSessionPersistenceDisabled(): boolean {
  return getState().sessionPersistenceDisabled
}

export function hasExitedPlanModeInSession(): boolean {
  return getState().hasExitedPlanMode
}

export function setHasExitedPlanMode(value: boolean): void {
  getState().hasExitedPlanMode = value
}

export function needsPlanModeExitAttachment(): boolean {
  return getState().needsPlanModeExitAttachment
}

export function setNeedsPlanModeExitAttachment(value: boolean): void {
  getState().needsPlanModeExitAttachment = value
}

export function handlePlanModeTransition(
  fromMode: string,
  toMode: string,
): void {
  const s = getState()
  // If switching TO plan mode, clear any pending exit attachment
  // This prevents sending both plan_mode and plan_mode_exit when user toggles quickly
  if (toMode === 'plan' && fromMode !== 'plan') {
    s.needsPlanModeExitAttachment = false
  }

  // If switching out of plan mode, trigger the plan_mode_exit attachment
  if (fromMode === 'plan' && toMode !== 'plan') {
    s.needsPlanModeExitAttachment = true
  }
}

export function needsAutoModeExitAttachment(): boolean {
  return getState().needsAutoModeExitAttachment
}

export function setNeedsAutoModeExitAttachment(value: boolean): void {
  getState().needsAutoModeExitAttachment = value
}

export function handleAutoModeTransition(
  fromMode: string,
  toMode: string,
): void {
  const s = getState()
  // Auto↔plan transitions are handled by prepareContextForPlanMode (auto may
  // stay active through plan if opted in) and ExitPlanMode (restores mode).
  // Skip both directions so this function only handles direct auto transitions.
  if (
    (fromMode === 'auto' && toMode === 'plan') ||
    (fromMode === 'plan' && toMode === 'auto')
  ) {
    return
  }
  const fromIsAuto = fromMode === 'auto'
  const toIsAuto = toMode === 'auto'

  // If switching TO auto mode, clear any pending exit attachment
  // This prevents sending both auto_mode and auto_mode_exit when user toggles quickly
  if (toIsAuto && !fromIsAuto) {
    s.needsAutoModeExitAttachment = false
  }

  // If switching out of auto mode, trigger the auto_mode_exit attachment
  if (fromIsAuto && !toIsAuto) {
    s.needsAutoModeExitAttachment = true
  }
}

// LSP plugin recommendation session tracking
export function hasShownLspRecommendationThisSession(): boolean {
  return getState().lspRecommendationShownThisSession
}

export function setLspRecommendationShownThisSession(value: boolean): void {
  getState().lspRecommendationShownThisSession = value
}

// SDK init event state
export function setInitJsonSchema(schema: Record<string, unknown>): void {
  getState().initJsonSchema = schema
}

export function getInitJsonSchema(): Record<string, unknown> | null {
  return getState().initJsonSchema
}

export function registerHookCallbacks(
  hooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>>,
): void {
  const s = getState()
  if (!s.registeredHooks) {
    s.registeredHooks = {}
  }

  // `registerHookCallbacks` may be called multiple times, so we need to merge (not overwrite)
  for (const [event, matchers] of Object.entries(hooks)) {
    const eventKey = event as HookEvent
    if (!s.registeredHooks[eventKey]) {
      s.registeredHooks[eventKey] = []
    }
    s.registeredHooks[eventKey]!.push(...matchers)
  }
}

export function getRegisteredHooks(): Partial<
  Record<HookEvent, RegisteredHookMatcher[]>
> | null {
  return getState().registeredHooks
}

export function clearRegisteredHooks(): void {
  getState().registeredHooks = null
}

export function clearRegisteredPluginHooks(): void {
  const s = getState()
  if (!s.registeredHooks) {
    return
  }

  const filtered: Partial<Record<HookEvent, RegisteredHookMatcher[]>> = {}
  for (const [event, matchers] of Object.entries(s.registeredHooks)) {
    // Keep only callback hooks (those without pluginRoot)
    const callbackHooks = matchers.filter(m => !('pluginRoot' in m))
    if (callbackHooks.length > 0) {
      filtered[event as HookEvent] = callbackHooks
    }
  }

  s.registeredHooks = Object.keys(filtered).length > 0 ? filtered : null
}

export function resetSdkInitState(): void {
  const s = getState()
  s.initJsonSchema = null
  s.registeredHooks = null
}

export function getPlanSlugCache(): Map<string, string> {
  return getState().planSlugCache
}

export function getSessionCreatedTeams(): Set<string> {
  return getState().sessionCreatedTeams
}

// Teleported session tracking for reliability logging
export function setTeleportedSessionInfo(info: {
  sessionId: string | null
}): void {
  getState().teleportedSessionInfo = {
    isTeleported: true,
    hasLoggedFirstMessage: false,
    sessionId: info.sessionId,
  }
}

export function getTeleportedSessionInfo(): {
  isTeleported: boolean
  hasLoggedFirstMessage: boolean
  sessionId: string | null
} | null {
  return getState().teleportedSessionInfo
}

export function markFirstTeleportMessageLogged(): void {
  const s = getState()
  if (s.teleportedSessionInfo) {
    s.teleportedSessionInfo.hasLoggedFirstMessage = true
  }
}

// Invoked skills tracking for preservation across compaction
export type InvokedSkillInfo = {
  skillName: string
  skillPath: string
  content: string
  invokedAt: number
  agentId: string | null
}

export function addInvokedSkill(
  skillName: string,
  skillPath: string,
  content: string,
  agentId: string | null = null,
): void {
  const key = `${agentId ?? ''}:${skillName}`
  getState().invokedSkills.set(key, {
    skillName,
    skillPath,
    content,
    invokedAt: Date.now(),
    agentId,
  })
}

export function removeInvokedSkill(
  skillName: string,
  agentId: string | null = null,
): void {
  getState().invokedSkills.delete(`${agentId ?? ''}:${skillName}`)
}

export function getInvokedSkills(): Map<string, InvokedSkillInfo> {
  return getState().invokedSkills
}

export function getInvokedSkillsForAgent(
  agentId: string | undefined | null,
): Map<string, InvokedSkillInfo> {
  const normalizedId = agentId ?? null
  const filtered = new Map<string, InvokedSkillInfo>()
  for (const [key, skill] of getState().invokedSkills) {
    if (skill.agentId === normalizedId) {
      filtered.set(key, skill)
    }
  }
  return filtered
}

export function clearInvokedSkills(
  preservedAgentIds?: ReadonlySet<string>,
): void {
  const skills = getState().invokedSkills
  if (!preservedAgentIds || preservedAgentIds.size === 0) {
    skills.clear()
    return
  }
  for (const [key, skill] of skills) {
    if (skill.agentId === null || !preservedAgentIds.has(skill.agentId)) {
      skills.delete(key)
    }
  }
}

export function clearInvokedSkillsForAgent(agentId: string): void {
  const skills = getState().invokedSkills
  for (const [key, skill] of skills) {
    if (skill.agentId === agentId) {
      skills.delete(key)
    }
  }
}

// Slow operations tracking for dev bar
const MAX_SLOW_OPERATIONS = 10
const SLOW_OPERATION_TTL_MS = 10000

export function addSlowOperation(operation: string, durationMs: number): void {
  if (process.env.USER_TYPE !== 'ant') return
  // Skip tracking for editor sessions (user editing a prompt file in $EDITOR)
  // These are intentionally slow since the user is drafting text
  if (operation.includes('exec') && operation.includes('claude-prompt-')) {
    return
  }
  const s = getState()
  const now = Date.now()
  // Remove stale operations
  s.slowOperations = s.slowOperations.filter(
    op => now - op.timestamp < SLOW_OPERATION_TTL_MS,
  )
  // Add new operation
  s.slowOperations.push({ operation, durationMs, timestamp: now })
  // Keep only the most recent operations
  if (s.slowOperations.length > MAX_SLOW_OPERATIONS) {
    s.slowOperations = s.slowOperations.slice(-MAX_SLOW_OPERATIONS)
  }
}

const EMPTY_SLOW_OPERATIONS: ReadonlyArray<{
  operation: string
  durationMs: number
  timestamp: number
}> = []

export function getSlowOperations(): ReadonlyArray<{
  operation: string
  durationMs: number
  timestamp: number
}> {
  const s = getState()
  // Most common case: nothing tracked. Return a stable reference so the
  // caller's setState() can bail via Object.is instead of re-rendering at 2fps.
  if (s.slowOperations.length === 0) {
    return EMPTY_SLOW_OPERATIONS
  }
  const now = Date.now()
  // Only allocate a new array when something actually expired; otherwise keep
  // the reference stable across polls while ops are still fresh.
  if (
    s.slowOperations.some(op => now - op.timestamp >= SLOW_OPERATION_TTL_MS)
  ) {
    s.slowOperations = s.slowOperations.filter(
      op => now - op.timestamp < SLOW_OPERATION_TTL_MS,
    )
    if (s.slowOperations.length === 0) {
      return EMPTY_SLOW_OPERATIONS
    }
  }
  // Safe to return directly: addSlowOperation() reassigns s.slowOperations
  // before pushing, so the array held in React state is never mutated.
  return s.slowOperations
}

export function getMainThreadAgentType(): string | undefined {
  return getState().mainThreadAgentType
}

export function setMainThreadAgentType(agentType: string | undefined): void {
  getState().mainThreadAgentType = agentType
}

export function getIsRemoteMode(): boolean {
  return getState().isRemoteMode
}

export function setIsRemoteMode(value: boolean): void {
  getState().isRemoteMode = value
}

// System prompt section accessors

export function getSystemPromptSectionCache(): Map<string, string | null> {
  return getState().systemPromptSectionCache
}

export function setSystemPromptSectionCacheEntry(
  name: string,
  value: string | null,
): void {
  getState().systemPromptSectionCache.set(name, value)
}

export function clearSystemPromptSectionState(): void {
  getState().systemPromptSectionCache.clear()
}

// Last emitted date accessors (for detecting midnight date changes)

export function getLastEmittedDate(): string | null {
  return getState().lastEmittedDate
}

export function setLastEmittedDate(date: string | null): void {
  getState().lastEmittedDate = date
}

export function getAdditionalDirectoriesForClaudeMd(): string[] {
  return getState().additionalDirectoriesForClaudeMd
}

export function setAdditionalDirectoriesForClaudeMd(
  directories: string[],
): void {
  getState().additionalDirectoriesForClaudeMd = directories
}

export function getAllowedChannels(): ChannelEntry[] {
  return getState().allowedChannels
}

export function setAllowedChannels(entries: ChannelEntry[]): void {
  getState().allowedChannels = entries
}

export function getHasDevChannels(): boolean {
  return getState().hasDevChannels
}

export function setHasDevChannels(value: boolean): void {
  getState().hasDevChannels = value
}

export function getPromptCache1hAllowlist(): string[] | null {
  return getState().promptCache1hAllowlist
}

export function setPromptCache1hAllowlist(allowlist: string[] | null): void {
  getState().promptCache1hAllowlist = allowlist
}

export function getPromptCache1hEligible(): boolean | null {
  return getState().promptCache1hEligible
}

export function setPromptCache1hEligible(eligible: boolean | null): void {
  getState().promptCache1hEligible = eligible
}

export function getAfkModeHeaderLatched(): boolean | null {
  return getState().afkModeHeaderLatched
}

export function setAfkModeHeaderLatched(v: boolean): void {
  getState().afkModeHeaderLatched = v
}

export function getFastModeHeaderLatched(): boolean | null {
  return getState().fastModeHeaderLatched
}

export function setFastModeHeaderLatched(v: boolean): void {
  getState().fastModeHeaderLatched = v
}

export function getCacheEditingHeaderLatched(): boolean | null {
  return getState().cacheEditingHeaderLatched
}

export function setCacheEditingHeaderLatched(v: boolean): void {
  getState().cacheEditingHeaderLatched = v
}

export function getThinkingClearLatched(): boolean | null {
  return getState().thinkingClearLatched
}

export function setThinkingClearLatched(v: boolean): void {
  getState().thinkingClearLatched = v
}

/**
 * Reset beta header latches to null. Called on /clear and /compact so a
 * fresh conversation gets fresh header evaluation.
 */
export function clearBetaHeaderLatches(): void {
  const s = getState()
  s.afkModeHeaderLatched = null
  s.fastModeHeaderLatched = null
  s.cacheEditingHeaderLatched = null
  s.thinkingClearLatched = null
}

export function getPromptId(): string | null {
  return getState().promptId
}

export function setPromptId(id: string | null): void {
  getState().promptId = id
}
