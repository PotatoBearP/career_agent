import { randomUUID } from 'node:crypto'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { resolveArtifactForWorkspace } from '../../artifacts/actionArtifactResolver.js'
import { learningStateService, type LearningPlanState } from '../../learning/learningStateService.js'

const inputSchema = lazySchema(() => z.strictObject({ plan_ref: z.string().regex(/^artifact:\/\/[0-9a-f-]{36}$/i) }))
type InputSchema = ReturnType<typeof inputSchema>
const outputSchema = lazySchema(() => z.strictObject({
  activated: z.literal(true), activation_status: z.enum(['created', 'already_active', 'reactivated']),
  plan_id: z.string(), plan_ref: z.string(), plan_artifact_uid: z.string().uuid(), status: z.literal('active'),
  current_stage_id: z.string(), current_stage_status: z.enum(['not_started', 'in_progress', 'ready_for_assessment', 'completed']),
  focus: z.literal(true), stage_count: z.number().int().positive(),
}))
type OutputSchema = ReturnType<typeof outputSchema>

const canonicalPlanSchema = z.strictObject({
  schema_version: z.literal('1.0'), artifact_type: z.literal('LearningPlan'), created_at: z.string(),
  lineage: z.object({ skill_call_id: z.string(), skill_name: z.string(), agent_id: z.string() }),
  plan: z.object({
    version: z.number().int().positive(), updated_at: z.string().datetime({ offset: true }),
    planning_constraints: z.object({ available_time_per_week: z.string().min(1), deadline: z.string().nullable() }),
    stages: z.array(z.object({ id: z.string().trim().min(1) })).min(1),
  }).passthrough(),
})
type ActivationValue = {
  status: 'created' | 'already_active' | 'reactivated'
  plan: LearningPlanState
}

export const ActivateLearningPlanTool = buildTool({
  name: 'ActivateLearningPlan', searchHint: 'activate a user-approved LearningPlan artifact for execution',
  maxResultSizeChars: 20_000, strict: true, alwaysLoad: true,
  async description() { return 'Activate an existing LearningPlan artifact as an executable logical plan. Only call after the user explicitly accepted the plan or explicitly requested to start executing it.' },
  async prompt() { return 'This deterministic state tool does not infer user confirmation, revise a plan, or start a stage. Pass only an opaque artifact:// reference.' },
  get inputSchema(): InputSchema { return inputSchema() }, get outputSchema(): OutputSchema { return outputSchema() },
  userFacingName() { return 'Activate learning plan' }, isEnabled() { return true }, isConcurrencySafe() { return false }, isReadOnly() { return false },
  toAutoClassifierInput(input) { return JSON.stringify(input) }, async checkPermissions(input) { return { behavior: 'allow', updatedInput: input } },
  renderToolUseMessage() { return 'Activating learning plan' }, renderToolUseErrorMessage() { return 'Learning plan activation failed' },
  renderToolResultMessage(output) { return `Learning plan ${output.activation_status}` },
  async call(input, context) {
    const runtime = context.actionArtifactRuntime
    if (!runtime?.userId) throw new Error('ARTIFACT_ACCESS_DENIED: Authenticated user workspace required')
    const artifact = await resolveArtifactForWorkspace({ userId: String(runtime.userId), workspaceDir: runtime.workspaceDir,
      artifactRef: input.plan_ref, expectedType: 'LearningPlan', supportedSchemaVersions: ['1.0'] })
    let canonical: z.infer<typeof canonicalPlanSchema>
    try { canonical = canonicalPlanSchema.parse(artifact.canonical) } catch { throw new Error('INVALID_LEARNING_PLAN: LearningPlan artifact is invalid') }
    const stageIds = canonical.plan.stages.map(stage => stage.id)
    if (new Set(stageIds).size !== stageIds.length) throw new Error('INVALID_LEARNING_PLAN: Stage IDs must be unique')
    const now = new Date().toISOString()
    const transaction = await learningStateService.transact<ActivationValue>(runtime.workspaceDir, state => {
      const existingIndex = state.plans.findIndex(plan => plan.plan_artifact_uid.toLowerCase() === artifact.artifactUid)
      if (existingIndex >= 0) {
        const existing = state.plans[existingIndex]!
        if (existing.status === 'completed') throw new Error('PLAN_ALREADY_COMPLETED: Completed plans cannot be activated')
        if (existing.status === 'archived') throw new Error('PLAN_ARCHIVED: Archived plans cannot be activated')
        if (existing.status === 'active') {
          const changed = state.focus_plan_id !== existing.plan_id
          return { state: changed ? { ...state, focus_plan_id: existing.plan_id } : state,
            value: { status: 'already_active' as const, plan: existing }, changed }
        }
        const reactivated: LearningPlanState = { ...existing, status: 'active', updated_at: now }
        const plans = [...state.plans]; plans[existingIndex] = reactivated
        return { state: { ...state, plans, focus_plan_id: existing.plan_id },
          value: { status: 'reactivated' as const, plan: reactivated }, changed: true }
      }
      const created: LearningPlanState = { plan_id: `lp_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
        plan_ref: artifact.artifactRef, plan_artifact_uid: artifact.artifactUid, status: 'active',
        current_stage_id: stageIds[0]!, current_stage_status: 'not_started', completed_stage_ids: [],
        current_stage_package_ref: null, latest_assessment_ref: null, activated_at: now, updated_at: now }
      return { state: { ...state, plans: [...state.plans, created], focus_plan_id: created.plan_id },
        value: { status: 'created' as const, plan: created }, changed: true }
    })
    const { plan } = transaction.value
    return { data: { activated: true as const, activation_status: transaction.value.status, plan_id: plan.plan_id,
      plan_ref: plan.plan_ref, plan_artifact_uid: plan.plan_artifact_uid, status: 'active' as const,
      current_stage_id: plan.current_stage_id!, current_stage_status: plan.current_stage_status!, focus: true as const,
      stage_count: stageIds.length } }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) { return { type: 'tool_result', tool_use_id: toolUseID, content: JSON.stringify(content) } },
} satisfies ToolDef<InputSchema, z.infer<OutputSchema>>)
