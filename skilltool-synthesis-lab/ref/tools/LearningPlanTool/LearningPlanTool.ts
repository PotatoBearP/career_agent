import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  executeSkillAction,
  getSkillActionCommand,
} from '../../skills/skillAction.js'
import { assertActionArtifactPublished, publishActionArtifact, toPublicActionArtifactPublication } from '../../artifacts/actionArtifactPublisher.js'
import { createLearningPlanArtifactAdapter } from './artifactAdapter.js'
import { resolveArtifactForWorkspace } from '../../artifacts/actionArtifactResolver.js'
import type { JsonValue } from '../../skills/skillLifecycleTypes.js'
import { lazySchema } from '../../utils/lazySchema.js'

const SKILL_NAME = "learning-plan" as const

const inputSchema = lazySchema(() =>
  z.strictObject({
    model_ref: z.string().trim().min(1).optional().describe(
      "Opaque artifact:// reference for a CareerCompetencyModel. Omit to resolve the most recent matching Action result in context.",
    ),
    baseline_ref: z.string().trim().min(1).optional().describe(
      "Opaque artifact:// reference for a BaselineAssessment. Omit to resolve the most recent matching Action result in context.",
    ),
    goal_level: z
      .enum(['working', 'independent', 'advanced'])
      .optional()
      .describe(
        "User's personal goal on the depth ladder. Omit for market-aligned (the model's expected_depth per competency). Only pass a value the user actually stated; ask via AskUserQuestion before calling when it is unknown and would materially change the plan's scope.",
      ),
    constraints: z
      .strictObject({
        available_time_per_week: z.string().trim().min(1).describe(
          "User-stated weekly available time for learning.",
        ),
        deadline: z.string().trim().min(1).nullable().describe(
          "User-stated deadline, or null only when the user explicitly said they have no deadline.",
        ),
        resource_constraints: z.string().trim().min(1).optional().describe(
          "User-stated resource constraints, e.g. self-study only.",
        ),
        explicit_goals: z.string().trim().min(1).optional().describe(
          "User-stated explicit goals for this plan.",
        ),
        notes: z.string().trim().min(1).optional().describe(
          "Other situational constraints or goals the user stated.",
        ),
      })
      .describe(
        "User-stated planning constraints. Before calling, ask the user via AskUserQuestion for any missing required values or other missing inputs that would materially change the plan; batch missing questions into one call. Never invent constraints.",
      ),
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

export const LearningPlanTool = buildTool({
  name: "LearningPlan",
  searchHint: "build a staged learning path from a competency model and a baseline assessment",
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
    return "Learning plan"
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
    return "Build learning plan from model and baseline"
  },
  renderToolUseRejectedMessage() {
    return "Learning plan rejected"
  },
  renderToolUseErrorMessage() {
    return "Learning plan failed"
  },
  renderToolUseProgressMessage() {
    return "Building learning plan"
  },
  renderToolResultMessage(output) {
    return output.summary
  },
  async call(input, context, canUseTool) {
    const runtime = context.actionArtifactRuntime
    if (!runtime?.userId) throw new Error('ARTIFACT_ACCESS_DENIED: Authenticated user workspace required')
    const transcript = JSON.stringify((context as unknown as { messages?: unknown }).messages ?? [])
    const refs = [...transcript.matchAll(/artifact:\/\/[0-9a-f-]{36}/gi)].map(match => match[0]).reverse()
    const resolveLatest = async (explicit: string | undefined, type: string) => {
      for (const ref of explicit ? [explicit] : refs) {
        try { return await resolveArtifactForWorkspace({ userId: String(runtime.userId), workspaceDir: runtime.workspaceDir,
          artifactRef: ref, expectedType: type, supportedSchemaVersions: ['1.0'] }) } catch (error) {
          if (explicit) throw error
        }
      }
      return undefined
    }
    const [model, baseline] = await Promise.all([
      resolveLatest(input.model_ref, 'career-competency-model'),
      resolveLatest(input.baseline_ref, 'baseline-assessment'),
    ])
    const actionInput = JSON.parse(JSON.stringify({ ...input,
      model_ref: model?.artifactRef ?? input.model_ref ?? null,
      baseline_ref: baseline?.artifactRef ?? input.baseline_ref ?? null,
      model: model?.canonical ?? null,
      baseline: baseline?.canonical ?? null,
    })) as JsonValue
    const completion = await executeSkillAction({
      skillName: SKILL_NAME,
      actionInput,
      context,
      canUseTool,
    })
    const workspaceDir = runtime.workspaceDir
    const artifact = await publishActionArtifact({
      completion,
      adapter: createLearningPlanArtifactAdapter(workspaceDir),
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
