import { beforeEach, describe, expect, test } from 'bun:test'
import {
  getInvokedSkills,
  resetStateForTests,
} from '../src/bootstrap/state.js'
import {
  beginSkillInvocation,
  buildSkillInvocationEnvelope,
  drainSkillLifecycleEvents,
  failSkillInvocationLoading,
  finalizeAllActiveSkillInvocations,
  finalizeActiveSkillInvocations,
  getSkillInvocation,
  markSkillInvocationRunning,
  returnSkillResult,
  validateReturnSkillResult,
} from '../src/skills/skillLifecycle.js'
import { ReturnSkillResultTool } from '../src/tools/ReturnSkillResultTool/ReturnSkillResultTool.js'
import { BaselineAssessmentTool } from '../src/tools/BaselineAssessmentTool/BaselineAssessmentTool.js'
import { getEmptyToolPermissionContext } from '../src/Tool.js'
import { getAllBaseTools, getTools } from '../src/tools.js'

function startSkill(
  skillName: string,
  agentId: string | null = null,
  content = `prompt:${skillName}`,
) {
  const invocation = beginSkillInvocation(skillName, agentId)
  const injectedContent = `${content}${buildSkillInvocationEnvelope(invocation)}`
  markSkillInvocationRunning({
    skillCallId: invocation.skillCallId,
    injectedContent,
    skillPath: `skills:${skillName}`,
  })
  return invocation
}

describe('Prompt Skill invocation lifecycle', () => {
  beforeEach(() => {
    resetStateForTests()
  })

  test('registers ReturnSkillResult as an always-loaded base tool', () => {
    expect(ReturnSkillResultTool.name).toBe('ReturnSkillResult')
    expect(ReturnSkillResultTool.alwaysLoad).toBe(true)
    expect(getAllBaseTools()).toContain(ReturnSkillResultTool)
  })

  test('registers BaselineAssessment as a normal always-loaded base tool', () => {
    expect(BaselineAssessmentTool.name).toBe('BaselineAssessment')
    expect(BaselineAssessmentTool.alwaysLoad).toBe(true)
    expect(getAllBaseTools()).toContain(BaselineAssessmentTool)
  })

  test('keeps ReturnSkillResult available through mode and deny filtering', () => {
    const permissionContext = {
      ...getEmptyToolPermissionContext(),
      alwaysDenyRules: { cliArg: ['ReturnSkillResult'] },
    }
    expect(getTools(permissionContext)).toContain(ReturnSkillResultTool)

    const previousSimpleMode = process.env.CLAUDE_CODE_SIMPLE
    process.env.CLAUDE_CODE_SIMPLE = '1'
    try {
      expect(getTools(permissionContext)).toContain(ReturnSkillResultTool)
    } finally {
      if (previousSimpleMode === undefined) {
        delete process.env.CLAUDE_CODE_SIMPLE
      } else {
        process.env.CLAUDE_CODE_SIMPLE = previousSimpleMode
      }
    }
  })

  test('allocates a new runtime ID and injects a neutral completion protocol', () => {
    const first = startSkill('learning-plan')
    finalizeActiveSkillInvocations(null, 'unreported')
    const second = startSkill('learning-plan')
    const envelope = buildSkillInvocationEnvelope(second)

    expect(first.skillCallId).not.toBe(second.skillCallId)
    expect(envelope).toContain(second.skillCallId)
    expect(envelope).toContain('insufficient_input')
    expect(envelope).toContain('does not end the Agent turn')
    expect(envelope.toLowerCase()).not.toContain('ask the user')
  })

  test('accepts all business outcomes and emits one completion event', () => {
    for (const outcome of ['success', 'insufficient_input', 'error'] as const) {
      const invocation = startSkill(`skill-${outcome}`)
      const confirmation = returnSkillResult({
        skill_call_id: invocation.skillCallId,
        skill_name: invocation.skillName,
        outcome,
        summary: `finished as ${outcome}`,
        result: { outcome },
      })
      expect(confirmation).toMatchObject({
        accepted: true,
        duplicate: false,
        outcome,
      })
    }

    expect(drainSkillLifecycleEvents().map(event => event.outcome)).toEqual([
      'success',
      'insufficient_input',
      'error',
    ])
    expect(drainSkillLifecycleEvents()).toEqual([])
  })

  test('is idempotent only for an identical repeated result', () => {
    const invocation = startSkill('learning-plan')
    const input = {
      skill_call_id: invocation.skillCallId,
      skill_name: invocation.skillName,
      outcome: 'success' as const,
      summary: 'plan created',
      result: { weeks: 12 },
    }
    expect(returnSkillResult(input).duplicate).toBe(false)
    expect(returnSkillResult(input).duplicate).toBe(true)
    expect(validateReturnSkillResult({ ...input, summary: 'different' })).toEqual({
      ok: false,
      error: 'Skill invocation already ended with a different result',
    })
    expect(drainSkillLifecycleEvents()).toHaveLength(1)
  })

  test('enforces Agent ownership, skill name, and LIFO nesting', () => {
    const parent = startSkill('parent', 'agent-1')
    const child = startSkill('child', 'agent-1')

    expect(validateReturnSkillResult({
      skill_call_id: parent.skillCallId,
      skill_name: parent.skillName,
      outcome: 'success',
      summary: 'too early',
    }, 'agent-1')).toMatchObject({ ok: false })
    expect(validateReturnSkillResult({
      skill_call_id: child.skillCallId,
      skill_name: child.skillName,
      outcome: 'success',
      summary: 'wrong agent',
    }, 'agent-2')).toMatchObject({ ok: false })
    expect(validateReturnSkillResult({
      skill_call_id: child.skillCallId,
      skill_name: 'wrong-name',
      outcome: 'success',
      summary: 'wrong name',
    }, 'agent-1')).toMatchObject({ ok: false })

    returnSkillResult({
      skill_call_id: child.skillCallId,
      skill_name: child.skillName,
      outcome: 'insufficient_input',
      summary: 'missing data',
    }, 'agent-1')
    expect(validateReturnSkillResult({
      skill_call_id: parent.skillCallId,
      skill_name: parent.skillName,
      outcome: 'success',
      summary: 'parent resumed',
    }, 'agent-1')).toEqual({ ok: true, duplicate: false })
  })

  test('blocks a parent while a forked child Agent is active', () => {
    const parent = startSkill('parent')
    const child = beginSkillInvocation('child', 'fork-agent', null)
    markSkillInvocationRunning({
      skillCallId: child.skillCallId,
      injectedContent: 'child prompt',
      skillPath: 'skills:child',
    })

    expect(child.parentSkillCallId).toBe(parent.skillCallId)
    expect(validateReturnSkillResult({
      skill_call_id: parent.skillCallId,
      skill_name: parent.skillName,
      outcome: 'success',
      summary: 'too early',
    })).toEqual({ ok: false, error: 'A child Skill invocation is still active' })

    returnSkillResult({
      skill_call_id: child.skillCallId,
      skill_name: child.skillName,
      outcome: 'success',
      summary: 'child done',
    }, 'fork-agent')
    expect(validateReturnSkillResult({
      skill_call_id: parent.skillCallId,
      skill_name: parent.skillName,
      outcome: 'success',
      summary: 'parent can finish',
    })).toEqual({ ok: true, duplicate: false })
  })

  test('restores an outer same-name prompt after the inner invocation ends', () => {
    const outer = startSkill('same-name', null, 'outer')
    const inner = startSkill('same-name', null, 'inner')
    expect(getInvokedSkills().get(':same-name')?.content).toContain('inner')

    returnSkillResult({
      skill_call_id: inner.skillCallId,
      skill_name: inner.skillName,
      outcome: 'success',
      summary: 'inner done',
    })
    expect(getInvokedSkills().get(':same-name')?.content).toContain('outer')

    returnSkillResult({
      skill_call_id: outer.skillCallId,
      skill_name: outer.skillName,
      outcome: 'success',
      summary: 'outer done',
    })
    expect(getInvokedSkills().has(':same-name')).toBe(false)
  })

  test('uses internal states for unreported/cancelled without completion events', () => {
    const unreported = startSkill('unreported')
    finalizeActiveSkillInvocations(null, 'unreported')
    expect(getSkillInvocation(unreported.skillCallId)?.status).toBe('unreported')

    const cancelled = startSkill('cancelled')
    finalizeActiveSkillInvocations(null, 'cancelled')
    expect(getSkillInvocation(cancelled.skillCallId)?.status).toBe('cancelled')
    expect(drainSkillLifecycleEvents()).toEqual([])
  })

  test('finalizes loading invocations during session teardown', () => {
    const loading = beginSkillInvocation('still-loading', 'agent-loading')
    finalizeAllActiveSkillInvocations('cancelled')
    expect(getSkillInvocation(loading.skillCallId)?.status).toBe('cancelled')
  })

  test('reports prompt loading failures as harness errors', () => {
    const invocation = beginSkillInvocation('broken-skill')
    failSkillInvocationLoading(invocation.skillCallId, new Error('cannot read SKILL.md'))

    expect(getSkillInvocation(invocation.skillCallId)).toMatchObject({
      status: 'terminal',
      outcome: 'error',
      completionSource: 'harness',
    })
    expect(drainSkillLifecycleEvents()[0]).toMatchObject({
      skillCallId: invocation.skillCallId,
      outcome: 'error',
      source: 'harness',
    })
  })
})
