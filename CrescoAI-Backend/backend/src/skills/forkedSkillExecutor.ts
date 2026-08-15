import type { ToolUseContext } from '../Tool.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { CommandBase, PromptCommand } from '../types/command.js'
import type { Message } from '../types/message.js'
import { getAgentContext } from '../utils/agentContext.js'
import { extractResultText, prepareForkedCommandContext } from '../utils/forkedAgent.js'
import { createUserMessage } from '../utils/messages.js'
import type { ModelAlias } from '../utils/model/aliases.js'
import { createAgentId } from '../utils/uuid.js'
import { clearInvokedSkillsForAgent } from '../bootstrap/state.js'
import { runAgent } from '../tools/AgentTool/runAgent.js'
import {
  beginSkillInvocation,
  buildSkillInvocationEnvelope,
  failSkillInvocationLoading,
  finalizeActiveSkillInvocations,
  getSkillInvocation,
  isLifecycleManagedSkill,
  markSkillInvocationRunning,
} from './skillLifecycle.js'
import type { JsonValue, SkillOutcome } from './skillLifecycleTypes.js'

export type ForkedSkillContextMode = 'isolated' | 'fork'

export type CompletedSkillAction = {
  skill_call_id: string
  skill_name: string
  agent_id: string
  execution_status: 'completed'
  outcome: SkillOutcome
  summary: string
  result?: JsonValue
  completed_at: string
  duration_ms: number
}

export type ForkedSkillExecution = {
  agentId: string
  resultText: string
  completion?: CompletedSkillAction
}

export class UnreportedSkillInvocationError extends Error {
  constructor(
    readonly skillCallId: string,
    readonly skillName: string,
  ) {
    super(
      `Skill ${skillName} ended without calling ReturnSkillResult (skill_call_id: ${skillCallId})`,
    )
    this.name = 'UnreportedSkillInvocationError'
  }
}

function actionInputBlock(input: JsonValue | undefined): string {
  if (input === undefined) return ''
  return [
    '',
    '<skill-action-input>',
    JSON.stringify(input),
    '</skill-action-input>',
  ].join('\n')
}

/**
 * Run a prompt Skill in a child Agent. `isolated` preserves the legacy forked
 * Skill behavior; `fork` copies the filtered parent transcript into the child.
 */
export async function executeForkedPromptSkill(input: {
  command: CommandBase & PromptCommand
  commandName: string
  args?: string
  actionInput?: JsonValue
  agentId?: string
  contextMode: ForkedSkillContextMode
  requireCompletion?: boolean
  context: ToolUseContext
  canUseTool: CanUseToolFn
  onMessage?: (message: Message, details: { agentId: string; skillContent: string }) => void
  runAgentImpl?: typeof runAgent
}): Promise<ForkedSkillExecution> {
  const agentId = input.agentId ?? createAgentId()
  const lifecycleInvocation = isLifecycleManagedSkill(input.command)
    ? beginSkillInvocation(
        input.commandName,
        agentId,
        input.context.agentId ?? getAgentContext()?.agentId ?? null,
      )
    : null

  let preparedContext: Awaited<ReturnType<typeof prepareForkedCommandContext>>
  try {
    preparedContext = await prepareForkedCommandContext(
      input.command,
      input.args ?? '',
      input.context,
    )
  } catch (error) {
    if (lifecycleInvocation) {
      failSkillInvocationLoading(lifecycleInvocation.skillCallId, error)
    }
    throw error
  }

  const skillContent = lifecycleInvocation
    ? `${preparedContext.skillContent}${actionInputBlock(input.actionInput)}${buildSkillInvocationEnvelope(lifecycleInvocation)}`
    : `${preparedContext.skillContent}${actionInputBlock(input.actionInput)}`
  const promptMessages = [createUserMessage({ content: skillContent })]
  const agentDefinition =
    input.command.effort !== undefined
      ? { ...preparedContext.baseAgent, effort: input.command.effort }
      : preparedContext.baseAgent

  if (lifecycleInvocation) {
    markSkillInvocationRunning({
      skillCallId: lifecycleInvocation.skillCallId,
      injectedContent: skillContent,
      skillPath: input.command.source
        ? `${input.command.source}:${input.command.name}`
        : input.command.name,
    })
  }

  // Snapshot the array before the child starts. runAgent applies the existing
  // incomplete-tool-call filter before sending these messages to the provider.
  const forkContextMessages =
    input.contextMode === 'fork' ? [...input.context.messages] : undefined
  const agentMessages: Message[] = []
  const run = input.runAgentImpl ?? runAgent

  try {
    for await (const message of run({
      agentDefinition,
      promptMessages,
      toolUseContext: {
        ...input.context,
        getAppState: preparedContext.modifiedGetAppState,
      },
      canUseTool: input.canUseTool,
      isAsync: false,
      forkContextMessages,
      querySource: 'agent:custom',
      model: input.command.model as ModelAlias | undefined,
      availableTools: input.context.options.tools,
      override: { agentId },
    })) {
      agentMessages.push(message)
      input.onMessage?.(message, { agentId, skillContent })
      if (
        lifecycleInvocation &&
        getSkillInvocation(lifecycleInvocation.skillCallId)?.status === 'terminal'
      ) {
        break
      }
    }
  } finally {
    finalizeActiveSkillInvocations(
      agentId,
      input.context.abortController.signal.aborted
        ? 'cancelled'
        : 'unreported',
    )
    clearInvokedSkillsForAgent(agentId)
  }

  const resultText = extractResultText(agentMessages, 'Skill execution completed')
  if (!lifecycleInvocation) return { agentId, resultText }

  const invocation = getSkillInvocation(lifecycleInvocation.skillCallId)
  if (
    invocation?.status !== 'terminal' ||
    !invocation.outcome ||
    !invocation.summary ||
    !invocation.completedAt
  ) {
    if (!input.requireCompletion) return { agentId, resultText }
    throw new UnreportedSkillInvocationError(
      lifecycleInvocation.skillCallId,
      input.commandName,
    )
  }

  return {
    agentId,
    resultText,
    completion: {
      skill_call_id: invocation.skillCallId,
      skill_name: invocation.skillName,
      agent_id: agentId,
      execution_status: 'completed',
      outcome: invocation.outcome,
      summary: invocation.summary,
      ...(invocation.result !== undefined ? { result: invocation.result } : {}),
      completed_at: new Date(invocation.completedAt).toISOString(),
      duration_ms: Math.max(0, invocation.completedAt - invocation.startedAt),
    },
  }
}
