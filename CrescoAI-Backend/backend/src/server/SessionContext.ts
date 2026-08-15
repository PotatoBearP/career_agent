/**
 * SessionContext.ts — AsyncLocalStorage-based context isolation for multi-user server mode
 *
 * Each HTTP/WebSocket request runs inside its own ALS context, so that
 * module-level helpers (getState, getCwd, etc.) transparently route to
 * the correct per-session STATE without any parameter threading.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { PermissionConfig } from './permissions.js'
import type {
  SessionFilesystemRoot,
  SessionReadOnlyRoot,
} from './filesystemPolicyTypes.js'
import {
  canonicalizePathForSecurity,
  isPathWithinRoot,
} from './workspaceSecurity.js'
import type { ConversationMemoryTurnState } from '../Network/memory/conversationMemoryTypes.js'
import type { MCPServerConnection } from '../services/mcp/types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionConfig = {
  apiKey?: string
  baseUrl?: string
  provider?: string
  model?: string
  appendSystemPrompt?: string
  cwd: string
  permissions?: PermissionConfig
  userId?: string
  /** Canonical security boundary for all user-owned filesystem operations. */
  workspaceRoot?: string
  /** Session-scoped auto-memory directory. Never derive this from process globals. */
  autoMemoryDir?: string
  /** User-scoped OpenClaw-style conversation-memory root. */
  conversationMemoryDir?: string
  /** The only conversation-memory summary file writable by this session. */
  conversationMemorySessionFile?: string
  /** User-owned inputs outside workspaceRoot, for example uploaded files. */
  userReadOnlyRoots?: readonly SessionReadOnlyRoot[]
  /** Application-owned resources intentionally readable by every user. */
  sharedReadOnlyRoots?: readonly SessionReadOnlyRoot[]
  /** Catalog boundaries from which a selected skill may request a narrower root. */
  trustedSkillCatalogRoots?: readonly SessionFilesystemRoot[]
  /** Server-managed state that agents must never access, including own-user state. */
  serviceOnlyRoots?: readonly SessionFilesystemRoot[]
}

export type ToolResponsePayload = {
  answers?: Record<string, string>
  annotations?: Record<string, { preview?: string; notes?: string }>
  approved: boolean
}

export type PendingToolResponse = {
  resolve: (payload: ToolResponsePayload) => void
  timeout: ReturnType<typeof setTimeout>
}

export type SessionContext = {
  sessionId: string
  userId?: string
  state: any // State type from bootstrap/state — avoid circular import
  config: SessionConfig
  anthropicClient: any | null
  queryEngine: any | null
  mcpClients: MCPServerConnection[]
  /** Runtime generation used to rebuild the QueryEngine when MCP configuration changes. */
  mcpRuntimeVersion?: number
  /** Only session-owned clients are closed when a conversation is disposed. */
  ownsMcpClients?: boolean
  wsConnections: Set<any>
  abortController: AbortController
  createdAt: number
  lastActivityAt: number
  isHeadless: true
  sessionSwitched: { subscribe: (fn: (...args: any[]) => void) => void; emit: (...args: any[]) => void }
  /** Interactive tools (e.g. AskUserQuestion) awaiting user responses via POST tool-response */
  pendingToolResponses: Map<string, PendingToolResponse>
  /** Dynamically granted, read-only roots for skills invoked in this session. */
  skillReadOnlyRoots?: Set<string>
  /** Per-request checkpoint used by the conversation-memory end-turn gate. */
  conversationMemoryTurn?: ConversationMemoryTurnState
}

// ---------------------------------------------------------------------------
// AsyncLocalStorage
// ---------------------------------------------------------------------------

const sessionAls = new AsyncLocalStorage<SessionContext>()

/**
 * Run a callback within a session's ALS context.
 */
export function runWithSessionContext<T>(ctx: SessionContext, fn: () => T): T {
  return sessionAls.run(ctx, fn)
}

/**
 * Get the current session context from ALS.
 */
export function getSessionContext(): SessionContext | undefined {
  return sessionAls.getStore()
}

/**
 * Check if we're currently running inside a server session context.
 */
export function isServerMode(): boolean {
  return sessionAls.getStore() !== undefined
}

/**
 * Register a selected skill's resource directory without changing cwd.
 * The requested root must be a canonical descendant of an application-owned
 * catalog configured when the Network session was created.
 */
export async function registerSessionSkillReadOnlyRoot(
  root: string,
): Promise<boolean> {
  const context = getSessionContext()
  if (!context || !root || root.includes('\0')) {
    return false
  }

  const canonicalRoot = await canonicalizePathForSecurity(
    root,
    context.config.cwd,
  )
  if (!canonicalRoot) return false

  let trusted = false
  for (const catalog of context.config.trustedSkillCatalogRoots ?? []) {
    const canonicalCatalog = await canonicalizePathForSecurity(
      catalog.root,
      context.config.cwd,
    )
    if (canonicalCatalog && isPathWithinRoot(canonicalRoot, canonicalCatalog)) {
      trusted = true
      break
    }
  }
  if (!trusted) return false

  context.skillReadOnlyRoots ??= new Set<string>()
  context.skillReadOnlyRoots.add(canonicalRoot)
  return true
}
