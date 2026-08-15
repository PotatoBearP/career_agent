import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  RETURN_SKILL_RESULT_TOOL_NAME,
  returnSkillResult,
  validateReturnSkillResult,
} from '../../skills/skillLifecycle.js'
import type {
  JsonValue,
  SkillOutcome,
} from '../../skills/skillLifecycleTypes.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    skill_call_id: z.string().min(1),
    skill_name: z.string().min(1),
    outcome: z.enum(['success', 'insufficient_input', 'error']),
    summary: z.string().min(1),
    result: z.json().optional(),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.strictObject({
    accepted: z.literal(true),
    duplicate: z.boolean(),
    skill_call_id: z.string(),
    skill_name: z.string(),
    outcome: z.enum(['success', 'insufficient_input', 'error']),
    summary: z.string(),
    result: z.json().optional(),
    completed_at: z.string(),
    duration_ms: z.number(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

type Input = {
  skill_call_id: string
  skill_name: string
  outcome: SkillOutcome
  summary: string
  result?: JsonValue
}

export const ReturnSkillResultTool = buildTool({
  name: RETURN_SKILL_RESULT_TOOL_NAME,
  searchHint: 'finish the current prompt skill invocation',
  maxResultSizeChars: 100_000,
  strict: true,
  alwaysLoad: true,
  async description() {
    return 'Close the active Skill invocation owned by this Agent and report its outcome. Do not call this for an Action Tool result that already has execution_status="completed". This does not end the Agent turn.'
  },
  async prompt() {
    return 'Call this after finishing the current Skill invocation, or when that invocation cannot continue. Use only the current invocation ID supplied directly to this Agent by the Harness. Never reuse a child Action Tool result\'s skill_call_id: execution_status="completed" means that child invocation is already closed. The tool closes the current Skill invocation but does not decide what the Agent does next.'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return ''
  },
  isEnabled() {
    return true
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput() {
    return ''
  },
  async validateInput(input, context) {
    const validation = validateReturnSkillResult(
      input as Input,
      context.agentId ?? null,
    )
    return validation.ok
      ? { result: true }
      : { result: false, message: validation.error, errorCode: 1 }
  },
  async checkPermissions(input) {
    return { behavior: 'allow', updatedInput: input }
  },
  renderToolUseMessage() {
    return null
  },
  async call(input, context) {
    return {
      data: returnSkillResult(input as Input, context.agentId ?? null),
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: JSON.stringify(content),
    }
  },
} satisfies ToolDef<InputSchema, z.infer<OutputSchema>>)
