import { randomUUID } from 'node:crypto'
import type { PromptCommand } from '../types/command.js'
import {
  addInvokedSkill,
  getState,
  removeInvokedSkill,
} from '../bootstrap/state.js'
import { logForDebugging } from '../utils/debug.js'
import type {
  JsonValue,
  SkillCompletedEvent,
  SkillCompletionSource,
  SkillInvocation,
  SkillOutcome,
} from './skillLifecycleTypes.js'

export const RETURN_SKILL_RESULT_TOOL_NAME = 'ReturnSkillResult'

const MAIN_AGENT_KEY = '__main__'
const MANAGED_SKILL_SOURCES = new Set([
  'skills',
  'plugin',
  'bundled',
  'mcp',
])

function agentKey(agentId: string | null | undefined): string {
  return agentId ?? MAIN_AGENT_KEY
}

function normalizeAgentId(agentId: string | null | undefined): string | null {
  return agentId ?? null
}

export function isLifecycleManagedSkill(command: PromptCommand): boolean {
  return Boolean(
    command.loadedFrom && MANAGED_SKILL_SOURCES.has(command.loadedFrom),
  )
}

export function beginSkillInvocation(
  skillName: string,
  agentId?: string | null,
  parentAgentId?: string | null,
): SkillInvocation {
  const state = getState()
  const normalizedAgentId = normalizeAgentId(agentId)
  const parentKey = agentKey(
    parentAgentId === undefined ? normalizedAgentId : parentAgentId,
  )
  const parentStack = state.activeSkillCallStackByAgent.get(parentKey) ?? []
  const invocation: SkillInvocation = {
    skillCallId: randomUUID(),
    skillName,
    sessionId: String(state.sessionId),
    agentId: normalizedAgentId,
    parentSkillCallId: parentStack.at(-1) ?? null,
    status: 'loading',
    startedAt: Date.now(),
  }
  state.skillInvocations.set(invocation.skillCallId, invocation)
  return invocation
}

export function buildSkillInvocationEnvelope(
  invocation: SkillInvocation,
): string {
  return [
    '',
    '<skill-invocation-protocol>',
    `skill_call_id: ${invocation.skillCallId}`,
    `skill_name: ${invocation.skillName}`,
    `parent_skill_call_id: ${invocation.parentSkillCallId ?? 'null'}`,
    '',
    `Before ending this Skill invocation, call ${RETURN_SKILL_RESULT_TOOL_NAME} with this skill_call_id and skill_name.`,
    'Valid outcomes:',
    '- success: this invocation achieved its goal.',
    '- insufficient_input: this invocation cannot continue with the information currently available.',
    '- error: this invocation failed.',
    `${RETURN_SKILL_RESULT_TOOL_NAME} closes only this Skill invocation; it does not end the Agent turn.`,
    'A call ID from an earlier invocation, including an earlier invocation of the same Skill, is not valid for this invocation.',
    '</skill-invocation-protocol>',
  ].join('\n')
}

export function markSkillInvocationRunning(input: {
  skillCallId: string
  injectedContent: string
  skillPath: string
}): SkillInvocation {
  const state = getState()
  const invocation = state.skillInvocations.get(input.skillCallId)
  if (!invocation || invocation.status !== 'loading') {
    throw new Error(`Skill invocation ${input.skillCallId} is not loading`)
  }

  invocation.status = 'running'
  invocation.injectedContent = input.injectedContent
  invocation.skillPath = input.skillPath
  const key = agentKey(invocation.agentId)
  const stack = state.activeSkillCallStackByAgent.get(key) ?? []
  stack.push(invocation.skillCallId)
  state.activeSkillCallStackByAgent.set(key, stack)
  addInvokedSkill(
    invocation.skillName,
    input.skillPath,
    input.injectedContent,
    invocation.agentId,
  )
  return invocation
}

function canonicalJson(value: JsonValue | undefined): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item)).join(',')}]`
  }
  return `{${Object.keys(value)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`
}

function reconcileInvokedSkill(invocation: SkillInvocation): void {
  const state = getState()
  const replacement = Array.from(state.skillInvocations.values())
    .filter(candidate =>
      candidate.skillCallId !== invocation.skillCallId &&
      candidate.agentId === invocation.agentId &&
      candidate.skillName === invocation.skillName &&
      candidate.status === 'running' &&
      candidate.injectedContent &&
      candidate.skillPath,
    )
    .sort((left, right) => right.startedAt - left.startedAt)[0]

  if (replacement?.injectedContent && replacement.skillPath) {
    addInvokedSkill(
      replacement.skillName,
      replacement.skillPath,
      replacement.injectedContent,
      replacement.agentId,
    )
    return
  }
  removeInvokedSkill(invocation.skillName, invocation.agentId)
}

function popInvocation(invocation: SkillInvocation): void {
  const state = getState()
  const key = agentKey(invocation.agentId)
  const stack = state.activeSkillCallStackByAgent.get(key) ?? []
  if (stack.at(-1) === invocation.skillCallId) {
    stack.pop()
  } else {
    const index = stack.lastIndexOf(invocation.skillCallId)
    if (index >= 0) stack.splice(index, 1)
  }
  if (stack.length === 0) state.activeSkillCallStackByAgent.delete(key)
  else state.activeSkillCallStackByAgent.set(key, stack)
}

function enqueueCompletionEvent(invocation: SkillInvocation): void {
  if (
    invocation.status !== 'terminal' ||
    !invocation.outcome ||
    !invocation.summary ||
    !invocation.completedAt ||
    !invocation.completionSource
  ) {
    return
  }
  getState().pendingSkillLifecycleEvents.push({
    skillCallId: invocation.skillCallId,
    skillName: invocation.skillName,
    outcome: invocation.outcome,
    summary: invocation.summary,
    ...(invocation.result !== undefined ? { result: invocation.result } : {}),
    startedAt: new Date(invocation.startedAt).toISOString(),
    completedAt: new Date(invocation.completedAt).toISOString(),
    durationMs: Math.max(0, invocation.completedAt - invocation.startedAt),
    source: invocation.completionSource,
  })
}

function closeWithBusinessOutcome(
  invocation: SkillInvocation,
  input: {
    outcome: SkillOutcome
    summary: string
    result?: JsonValue
    source: SkillCompletionSource
  },
): void {
  invocation.status = 'terminal'
  invocation.outcome = input.outcome
  invocation.summary = input.summary
  if (input.result !== undefined) invocation.result = input.result
  invocation.completedAt = Date.now()
  invocation.completionSource = input.source
  popInvocation(invocation)
  reconcileInvokedSkill(invocation)
  enqueueCompletionEvent(invocation)
}

export type ReturnSkillResultInput = {
  skill_call_id: string
  skill_name: string
  outcome: SkillOutcome
  summary: string
  result?: JsonValue
}

export type ReturnSkillResultConfirmation = {
  accepted: true
  duplicate: boolean
  skill_call_id: string
  skill_name: string
  outcome: SkillOutcome
  summary: string
  result?: JsonValue
  completed_at: string
  duration_ms: number
}

function confirmation(
  invocation: SkillInvocation,
  duplicate: boolean,
): ReturnSkillResultConfirmation {
  return {
    accepted: true,
    duplicate,
    skill_call_id: invocation.skillCallId,
    skill_name: invocation.skillName,
    outcome: invocation.outcome!,
    summary: invocation.summary!,
    ...(invocation.result !== undefined ? { result: invocation.result } : {}),
    completed_at: new Date(invocation.completedAt!).toISOString(),
    duration_ms: Math.max(0, invocation.completedAt! - invocation.startedAt),
  }
}

export function validateReturnSkillResult(
  input: ReturnSkillResultInput,
  agentId?: string | null,
): { ok: true; duplicate: boolean } | { ok: false; error: string } {
  const invocation = getState().skillInvocations.get(input.skill_call_id)
  if (!invocation) {
    return { ok: false, error: 'Unknown or expired skill_call_id' }
  }
  if (invocation.agentId !== normalizeAgentId(agentId)) {
    return { ok: false, error: 'skill_call_id belongs to another Agent' }
  }
  if (invocation.skillName !== input.skill_name) {
    return { ok: false, error: 'skill_name does not match skill_call_id' }
  }
  if (!input.summary.trim()) {
    return { ok: false, error: 'summary must be non-empty' }
  }

  if (invocation.status === 'terminal') {
    const duplicate =
      invocation.outcome === input.outcome &&
      invocation.summary === input.summary.trim() &&
      canonicalJson(invocation.result) === canonicalJson(input.result)
    return duplicate
      ? { ok: true, duplicate: true }
      : { ok: false, error: 'Skill invocation already ended with a different result' }
  }
  if (invocation.status !== 'running') {
    return { ok: false, error: `Skill invocation is ${invocation.status}` }
  }
  const stack =
    getState().activeSkillCallStackByAgent.get(agentKey(invocation.agentId)) ?? []
  if (stack.at(-1) !== invocation.skillCallId) {
    return { ok: false, error: 'Skill invocation is not the current Agent stack top' }
  }
  const hasRunningChild = Array.from(getState().skillInvocations.values()).some(
    candidate =>
      candidate.parentSkillCallId === invocation.skillCallId &&
      (candidate.status === 'loading' || candidate.status === 'running'),
  )
  if (hasRunningChild) {
    return { ok: false, error: 'A child Skill invocation is still active' }
  }
  return { ok: true, duplicate: false }
}

export function returnSkillResult(
  input: ReturnSkillResultInput,
  agentId?: string | null,
): ReturnSkillResultConfirmation {
  const validation = validateReturnSkillResult(input, agentId)
  if (!validation.ok) throw new Error(validation.error)
  const invocation = getState().skillInvocations.get(input.skill_call_id)!
  if (validation.duplicate) return confirmation(invocation, true)

  closeWithBusinessOutcome(invocation, {
    outcome: input.outcome,
    summary: input.summary.trim(),
    ...(input.result !== undefined ? { result: input.result } : {}),
    source: 'agent',
  })
  return confirmation(invocation, false)
}

export function failSkillInvocationLoading(
  skillCallId: string,
  error: unknown,
): void {
  const invocation = getState().skillInvocations.get(skillCallId)
  if (!invocation || invocation.status !== 'loading') return
  closeWithBusinessOutcome(invocation, {
    outcome: 'error',
    summary: error instanceof Error ? error.message : String(error),
    source: 'harness',
  })
}

export function finalizeActiveSkillInvocations(
  agentId: string | null | undefined,
  status: 'unreported' | 'cancelled',
): SkillInvocation[] {
  const state = getState()
  const key = agentKey(agentId)
  const stack = state.activeSkillCallStackByAgent.get(key) ?? []
  const finalized: SkillInvocation[] = []
  while (stack.length > 0) {
    const skillCallId = stack.pop()!
    const invocation = state.skillInvocations.get(skillCallId)
    if (!invocation || invocation.status !== 'running') continue
    invocation.status = status
    invocation.completedAt = Date.now()
    invocation.completionSource = 'harness'
    reconcileInvokedSkill(invocation)
    finalized.push(invocation)
    logForDebugging(
      `Skill invocation ${skillCallId} (${invocation.skillName}) ended as ${status}`,
    )
  }
  state.activeSkillCallStackByAgent.delete(key)
  for (const invocation of state.skillInvocations.values()) {
    if (
      invocation.agentId !== normalizeAgentId(agentId) ||
      invocation.status !== 'loading'
    ) {
      continue
    }
    invocation.status = status
    invocation.completedAt = Date.now()
    invocation.completionSource = 'harness'
    reconcileInvokedSkill(invocation)
    finalized.push(invocation)
    logForDebugging(
      `Skill invocation ${invocation.skillCallId} (${invocation.skillName}) ended as ${status}`,
    )
  }
  return finalized
}

export function finalizeAllActiveSkillInvocations(
  status: 'unreported' | 'cancelled',
): SkillInvocation[] {
  const state = getState()
  const agentIds = new Set(state.activeSkillCallStackByAgent.keys())
  for (const invocation of state.skillInvocations.values()) {
    if (invocation.status === 'loading' || invocation.status === 'running') {
      agentIds.add(agentKey(invocation.agentId))
    }
  }
  return Array.from(agentIds).flatMap(key =>
    finalizeActiveSkillInvocations(
      key === MAIN_AGENT_KEY ? null : key,
      status,
    ),
  )
}

export function drainSkillLifecycleEvents(): SkillCompletedEvent[] {
  const events = getState().pendingSkillLifecycleEvents.splice(0)
  return events
}

export function getSkillInvocation(
  skillCallId: string,
): SkillInvocation | undefined {
  return getState().skillInvocations.get(skillCallId)
}
