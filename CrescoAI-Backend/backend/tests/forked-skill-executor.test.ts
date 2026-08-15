import { beforeEach, describe, expect, test } from 'bun:test'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { resetStateForTests } from '../src/bootstrap/state.js'
import {
  executeForkedPromptSkill,
  UnreportedSkillInvocationError,
} from '../src/skills/forkedSkillExecutor.js'
import {
  drainSkillLifecycleEvents,
  getSkillInvocation,
  returnSkillResult,
} from '../src/skills/skillLifecycle.js'
import type { ToolUseContext } from '../src/Tool.js'
import type { PromptCommand } from '../src/types/command.js'
import { createUserMessage } from '../src/utils/messages.js'
import type { runAgent } from '../src/tools/AgentTool/runAgent.js'

function command(): PromptCommand {
  return {
    type: 'prompt',
    name: 'baseline-assessment',
    description: 'Assess existing evidence.',
    progressMessage: 'running',
    contentLength: 20,
    source: 'bundled',
    loadedFrom: 'bundled',
    modelEntry: 'action-tool',
    async getPromptForCommand(): Promise<ContentBlockParam[]> {
      return [{ type: 'text', text: 'Baseline prompt.' }]
    },
  }
}

function context(messages = [createUserMessage({ content: 'Existing evidence.' })]) {
  return {
    messages,
    abortController: new AbortController(),
    options: {
      tools: [],
      agentDefinitions: {
        activeAgents: [],
      },
    },
    getAppState() {
      return {}
    },
  } as ToolUseContext
}

function promptText(messages: Parameters<typeof runAgent>[0]['promptMessages']) {
  return messages
    .flatMap(message =>
      message.type === 'user' && typeof message.message.content === 'string'
        ? [message.message.content]
        : [],
    )
    .join('\n')
}

describe('forked Skill executor', () => {
  beforeEach(() => resetStateForTests())

  test('forks the parent snapshot and returns only ReturnSkillResult data', async () => {
    const parentMessages = [createUserMessage({ content: 'Existing evidence.' })]
    let captured: Parameters<typeof runAgent>[0] | undefined
    const fakeRunAgent = (async function* (input: Parameters<typeof runAgent>[0]) {
      captured = input
      const prompt = promptText(input.promptMessages)
      const skillCallId = /skill_call_id: ([^\n]+)/.exec(prompt)?.[1]
      if (!skillCallId || !input.override?.agentId) throw new Error('missing invocation')
      returnSkillResult(
        {
          skill_call_id: skillCallId,
          skill_name: 'baseline-assessment',
          outcome: 'success',
          summary: 'Existing evidence supports a low-confidence baseline.',
          result: { confidence: 'low' },
        },
        input.override.agentId,
      )
    }) as typeof runAgent

    const execution = await executeForkedPromptSkill({
      command: command(),
      commandName: 'baseline-assessment',
      actionInput: { assessment_target: 'backend engineering' },
      contextMode: 'fork',
      context: context(parentMessages),
      canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      runAgentImpl: fakeRunAgent,
    })

    expect(captured?.forkContextMessages).toEqual(parentMessages)
    expect(captured?.agentDefinition).toMatchObject({
      agentType: 'general-purpose',
      source: 'built-in',
    })
    expect(captured?.forkContextMessages).not.toBe(parentMessages)
    expect(promptText(captured!.promptMessages)).toContain(
      '"assessment_target":"backend engineering"',
    )
    expect(execution.completion).toMatchObject({
      skill_name: 'baseline-assessment',
      agent_id: execution.agentId,
      execution_status: 'completed',
      outcome: 'success',
      summary: 'Existing evidence supports a low-confidence baseline.',
      result: { confidence: 'low' },
    })
    expect(drainSkillLifecycleEvents()).toHaveLength(1)
  })

  test('marks a child that never returns as unreported and throws a Tool error', async () => {
    let skillCallId = ''
    const fakeRunAgent = (async function* (input: Parameters<typeof runAgent>[0]) {
      skillCallId = /skill_call_id: ([^\n]+)/.exec(
        promptText(input.promptMessages),
      )?.[1] ?? ''
    }) as typeof runAgent

    await expect(
      executeForkedPromptSkill({
        command: command(),
        commandName: 'baseline-assessment',
        contextMode: 'fork',
        requireCompletion: true,
        context: context(),
        canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
        runAgentImpl: fakeRunAgent,
      }),
    ).rejects.toBeInstanceOf(UnreportedSkillInvocationError)
    expect(getSkillInvocation(skillCallId)?.status).toBe('unreported')
    expect(drainSkillLifecycleEvents()).toEqual([])
  })

  test('stops the child execution at the ReturnSkillResult boundary', async () => {
    let continuedAfterReturn = false
    const fakeRunAgent = (async function* (input: Parameters<typeof runAgent>[0]) {
      const skillCallId = /skill_call_id: ([^\n]+)/.exec(
        promptText(input.promptMessages),
      )?.[1]
      if (!skillCallId || !input.override?.agentId) throw new Error('missing invocation')
      returnSkillResult(
        {
          skill_call_id: skillCallId,
          skill_name: 'baseline-assessment',
          outcome: 'success',
          summary: 'Assessment complete.',
        },
        input.override.agentId,
      )
      yield createUserMessage({ content: 'ReturnSkillResult accepted.' })
      continuedAfterReturn = true
      yield createUserMessage({ content: 'This must not be consumed.' })
    }) as typeof runAgent

    const execution = await executeForkedPromptSkill({
      command: command(),
      commandName: 'baseline-assessment',
      contextMode: 'fork',
      requireCompletion: true,
      context: context(),
      canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      runAgentImpl: fakeRunAgent,
    })

    expect(execution.completion?.outcome).toBe('success')
    expect(continuedAfterReturn).toBe(false)
  })
})
