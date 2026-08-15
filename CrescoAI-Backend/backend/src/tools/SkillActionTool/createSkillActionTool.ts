import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { z } from 'zod/v4'
import {
  buildTool,
  type AnyObject,
  type Tool,
  type ToolDef,
} from '../../Tool.js'
import {
  executeSkillAction,
  getSkillActionCommand,
} from '../../skills/skillAction.js'
import type { CompletedSkillAction } from '../../skills/forkedSkillExecutor.js'
import type { JsonValue } from '../../skills/skillLifecycleTypes.js'
import { lazySchema } from '../../utils/lazySchema.js'

export type SkillActionToolConfig<
  InputSchema extends AnyObject,
  SkillName extends string = string,
> = {
  skillName: SkillName
  toolName: string
  inputSchema: () => InputSchema
  userFacingName: string
  searchHint?: string
  alwaysLoad?: boolean
  readOnly?: boolean
  /**
   * Exact child-Agent tool names, excluding ReturnSkillResult, which the
   * runtime always adds. An empty array creates a ReturnSkillResult-only child.
   */
  childToolNames?: readonly string[]
  toActionInput?: (input: z.infer<InputSchema>) => JsonValue | undefined
  toClassifierInput?: (input: z.infer<InputSchema>) => string
  renderInvocation?: (input: Partial<z.infer<InputSchema>>) => string
  progressMessage?: string
}

/**
 * Builds the common Tool facade for a prompt Skill executed by a child Agent.
 * The Skill remains the source of instructions; this factory owns routing,
 * lifecycle completion, exact child-tool policy, and the public result shape.
 */
export function createSkillActionTool<
  InputSchema extends AnyObject,
  SkillName extends string,
>(
  config: SkillActionToolConfig<InputSchema, SkillName>,
): Tool<InputSchema, CompletedSkillAction> {
  const outputSchema = lazySchema(() =>
    z.strictObject({
      skill_call_id: z.string(),
      skill_name: z.literal(config.skillName),
      agent_id: z.string(),
      execution_status: z.literal('completed'),
      outcome: z.enum(['success', 'insufficient_input', 'error']),
      summary: z.string(),
      result: z.json().optional(),
      completed_at: z.string(),
      duration_ms: z.number(),
    }),
  )

  const tool = buildTool({
    name: config.toolName,
    ...(config.searchHint ? { searchHint: config.searchHint } : {}),
    maxResultSizeChars: 100_000,
    strict: true,
    alwaysLoad: config.alwaysLoad ?? false,
    async description() {
      return (await getSkillActionCommand(config.skillName)).description
    },
    async prompt() {
      return (await getSkillActionCommand(config.skillName)).description
    },
    get inputSchema(): InputSchema {
      return config.inputSchema()
    },
    get outputSchema() {
      return outputSchema()
    },
    userFacingName() {
      return config.userFacingName
    },
    isConcurrencySafe() {
      return false
    },
    isReadOnly() {
      return config.readOnly ?? true
    },
    toAutoClassifierInput(input) {
      return config.toClassifierInput?.(input) ?? JSON.stringify(input)
    },
    async checkPermissions(input) {
      return { behavior: 'allow', updatedInput: input }
    },
    renderToolUseMessage(input) {
      return config.renderInvocation?.(input) ?? `Run ${config.userFacingName}`
    },
    renderToolUseRejectedMessage() {
      return `${config.userFacingName} rejected`
    },
    renderToolUseErrorMessage() {
      return `${config.userFacingName} failed`
    },
    renderToolUseProgressMessage() {
      return config.progressMessage ?? `Running ${config.userFacingName}`
    },
    renderToolResultMessage(output) {
      return output.summary
    },
    async call(input, context, canUseTool) {
      const actionInput = config.toActionInput
        ? config.toActionInput(input)
        : Object.keys(input).length > 0
          ? (input as JsonValue)
          : undefined
      return {
        data: await executeSkillAction({
          skillName: config.skillName,
          actionInput,
          childToolNames: config.childToolNames ?? [],
          context,
          canUseTool,
        }),
      }
    },
    mapToolResultToToolResultBlockParam(
      content: CompletedSkillAction,
      toolUseID: string,
    ): ToolResultBlockParam {
      return {
        type: 'tool_result',
        tool_use_id: toolUseID,
        content: JSON.stringify(content),
      }
    },
  } satisfies ToolDef<InputSchema, CompletedSkillAction>)

  return tool
}
