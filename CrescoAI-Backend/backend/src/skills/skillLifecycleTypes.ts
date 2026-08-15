export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export type SkillOutcome = 'success' | 'insufficient_input' | 'error'

export type SkillInvocationStatus =
  | 'loading'
  | 'running'
  | 'terminal'
  | 'unreported'
  | 'cancelled'

export type SkillCompletionSource = 'agent' | 'harness'

export interface SkillInvocation {
  skillCallId: string
  skillName: string
  sessionId: string
  agentId: string | null
  parentSkillCallId: string | null
  status: SkillInvocationStatus
  outcome?: SkillOutcome
  summary?: string
  result?: JsonValue
  startedAt: number
  completedAt?: number
  completionSource?: SkillCompletionSource
  injectedContent?: string
  skillPath?: string
}

export interface SkillCompletedEvent {
  skillCallId: string
  skillName: string
  outcome: SkillOutcome
  summary: string
  result?: JsonValue
  startedAt: string
  completedAt: string
  durationMs: number
  source: SkillCompletionSource
}
