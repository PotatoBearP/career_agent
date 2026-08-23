import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  executeSkillAction,
  getSkillActionCommand,
} from '../../skills/skillAction.js'
import { assertActionArtifactPublished, publishActionArtifact, toPublicActionArtifactPublication } from '../../artifacts/actionArtifactPublisher.js'
import { createCareerCompetencyModelArtifactAdapter } from './artifactAdapter.js'
import { lazySchema } from '../../utils/lazySchema.js'

const SKILL_NAME = "career-competency-model" as const

const inputSchema = lazySchema(() =>
  z.strictObject({
    career_target: z.string().trim().min(1).describe("Clearly scoped career or job target. Include known industry, region, seniority, or specialization in the same string."),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.strictObject({
    skill_call_id: z.string(),
    skill_name: z.literal(SKILL_NAME),
    agent_id: z.string(),
    execution_status: z.literal('completed'),
    outcome: z.enum(['success', 'insufficient_input', 'error']),
    summary: z.string(),
    result: z.json().optional(),
    completed_at: z.string(),
    duration_ms: z.number(),
    artifact: z
      .strictObject({
        artifact_uid: z.string(),
        artifact_ref: z.string(),
        artifact_type: z.string(),
        schema_version: z.string(),
        status: z.enum(['ready', 'canonical_only', 'error']),
        render_mode: z.literal('html').optional(),
        error: z.string().optional(),
      })
      .optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

export const CareerCompetencyModelTool = buildTool({
  name: "CareerCompetencyModel",
  searchHint: "research current role competency requirements from web evidence",
  maxResultSizeChars: 100_000,
  strict: true,
  alwaysLoad: true,
  async description() {
    return (await getSkillActionCommand(SKILL_NAME)).description
  },
  async prompt() {
    return (await getSkillActionCommand(SKILL_NAME)).description
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return "Career competency model"
  },
  isEnabled() {
    return true
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  toAutoClassifierInput(input) {
    return JSON.stringify(input)
  },
  async checkPermissions(input) {
    return { behavior: 'allow', updatedInput: input }
  },
  renderToolUseMessage() {
    return "Run Career competency model"
  },
  renderToolUseRejectedMessage() {
    return "Career competency model rejected"
  },
  renderToolUseErrorMessage() {
    return "Career competency model failed"
  },
  renderToolUseProgressMessage() {
    return "Running Career competency model"
  },
  renderToolResultMessage(output) {
    return output.summary
  },
  async call(input, context, canUseTool) {
    const actionInput = Object.keys(input).length > 0 ? input : undefined
    const completion = await executeSkillAction({
      skillName: SKILL_NAME,
      actionInput,
      context,
      canUseTool,
    })
    const workspaceDir =
      context.actionArtifactRuntime?.workspaceDir ?? process.cwd()
    const artifact = await publishActionArtifact({
      completion,
      adapter: createCareerCompetencyModelArtifactAdapter(workspaceDir),
      workspaceDir,
      sessionId:
        context.actionArtifactRuntime?.sessionId ?? completion.skill_call_id,
      userId: context.actionArtifactRuntime?.userId ?? null,
    })
    assertActionArtifactPublished(completion, artifact)
    const { result: _internalResult, ...publicCompletion } = completion
    const data: Output = {
      ...publicCompletion,
      skill_name: SKILL_NAME,
      ...(artifact ? { artifact: toPublicActionArtifactPublication(artifact), result: { artifact_ref: artifact.artifact_ref } } : completion.result !== undefined ? { result: completion.result } : {}),
    }
    return {
      data,
    }
  },
  mapToolResultToToolResultBlockParam(
    content: Output,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: JSON.stringify(content),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
