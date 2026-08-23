import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool, type ToolDef } from "../../Tool.js";
import {
  executeSkillAction,
  getSkillActionCommand,
} from "../../skills/skillAction.js";
import { lazySchema } from "../../utils/lazySchema.js";
import { learningStateService } from "../../learning/learningStateService.js";
import { resolveArtifactForWorkspace } from "../../artifacts/actionArtifactResolver.js";
import {
  assertActionArtifactPublished,
  publishActionArtifact,
  toPublicActionArtifactPublication,
} from "../../artifacts/actionArtifactPublisher.js";
import { createLearningStagePackageAdapter } from "./artifactAdapter.js";
import type { JsonValue } from "../../skills/skillLifecycleTypes.js";

const SKILL_NAME = "learning-stage-design" as const;
const constraintsSchema = z.strictObject({
  available_time: z.string().trim().min(1).optional(),
  resource_constraints: z.string().trim().min(1).optional(),
  learning_preferences: z.string().trim().min(1).optional(),
  notes: z.string().trim().min(1).optional(),
});
const inputSchema = lazySchema(() =>
  z.strictObject({
    plan_id: z.string().trim().min(1).optional(),
    constraints: constraintsSchema.optional(),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;
const artifactSchema = z.strictObject({
  artifact_uid: z.string().uuid(),
  artifact_ref: z.string(),
  artifact_type: z.string(),
  schema_version: z.string(),
  status: z.enum(["ready", "canonical_only", "error"]),
  render_mode: z.literal("html").optional(),
  error: z.string().optional(),
});
const outputSchema = lazySchema(() =>
  z.strictObject({
    skill_call_id: z.string(),
    skill_name: z.literal(SKILL_NAME),
    agent_id: z.string(),
    execution_status: z.literal("completed"),
    outcome: z.enum(["success", "insufficient_input", "error"]),
    summary: z.string(),
    result: z.json().optional(),
    completed_at: z.string(),
    duration_ms: z.number(),
    artifact: artifactSchema.optional(),
  }),
);
type OutputSchema = ReturnType<typeof outputSchema>;
type Output = z.infer<OutputSchema>;

export const LearningStageDesignTool = buildTool({
  name: "LearningStageDesign",
  searchHint:
    "turn the current activated learning-plan stage into an executable learning package",
  maxResultSizeChars: 100_000,
  strict: true,
  alwaysLoad: true,
  async description() {
    return `${(await getSkillActionCommand(SKILL_NAME)).description} This Action accepts the plan_id returned by GetLearningState (or uses the focus plan when omitted) and resolves the opaque plan artifact internally; do not locate or read physical state/artifact files before calling it. After a ready stage package is returned, call UpdateLearningProgress with operation="start_stage" and its artifact_ref.`;
  },
  async prompt() {
    return `${(await getSkillActionCommand(SKILL_NAME)).description} Pass only plan_id and explicit user constraints. The Harness resolves plan_ref and current stage; never use Bash, Glob, or Read to discover them.`;
  },
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  get outputSchema(): OutputSchema {
    return outputSchema();
  },
  userFacingName() {
    return "Learning stage design";
  },
  isEnabled() {
    return true;
  },
  isConcurrencySafe() {
    return false;
  },
  isReadOnly() {
    return false;
  },
  toAutoClassifierInput(input) {
    return JSON.stringify(input);
  },
  async checkPermissions(input) {
    return { behavior: "allow", updatedInput: input };
  },
  renderToolUseMessage() {
    return "Design current learning stage";
  },
  renderToolUseRejectedMessage() {
    return "Learning stage design rejected";
  },
  renderToolUseErrorMessage() {
    return "Learning stage design failed";
  },
  renderToolUseProgressMessage() {
    return "Designing current learning stage";
  },
  renderToolResultMessage(output) {
    return output.summary;
  },
  async call(input, context, canUseTool) {
    const runtime = context.actionArtifactRuntime;
    if (!runtime?.userId)
      throw new Error(
        "STATE_READ_FAILED: Authenticated user workspace required",
      );
    const state = await learningStateService.getUserState(runtime.workspaceDir);
    const planId = input.plan_id ?? state.focus_plan_id;
    if (!planId)
      throw new Error("PLAN_NOT_FOUND: No focus learning plan is active");
    const planState = state.plans.find((plan) => plan.plan_id === planId);
    if (!planState)
      throw new Error("PLAN_NOT_FOUND: Learning plan was not found");
    if (!planState.current_stage_id)
      throw new Error("STAGE_NOT_FOUND: Learning plan has no current stage");
    const planArtifact = await resolveArtifactForWorkspace({
      userId: String(runtime.userId),
      workspaceDir: runtime.workspaceDir,
      artifactRef: planState.plan_ref,
      expectedType: "LearningPlan",
      supportedSchemaVersions: ["1.0"],
    });
    const plan = (
      planArtifact.canonical as {
        plan?: {
          version?: number;
          planning_constraints?: unknown;
          stages?: Array<{ id?: string }>;
        };
      }
    ).plan;
    const stage = plan?.stages?.find(
      (item) => item.id === planState.current_stage_id,
    );
    if (!plan || !stage)
      throw new Error(
        "STAGE_NOT_FOUND: Current stage is absent from the active plan",
      );
    const latestAssessment = planState.latest_assessment_ref
      ? (
          await resolveArtifactForWorkspace({
            userId: String(runtime.userId),
            workspaceDir: runtime.workspaceDir,
            artifactRef: planState.latest_assessment_ref,
            expectedType: "LearningProgressAssessment",
            supportedSchemaVersions: ["1.0"],
          })
        ).canonical
      : null;
    const actionInput = JSON.parse(
      JSON.stringify({
        plan_id: planState.plan_id,
        plan_ref: planState.plan_ref,
        plan_version: plan.version,
        current_stage: stage,
        planning_constraints: plan.planning_constraints ?? {},
        invocation_constraints: input.constraints ?? {},
        latest_assessment: latestAssessment,
      }),
    ) as JsonValue;
    const completion = await executeSkillAction({
      skillName: SKILL_NAME,
      context,
      canUseTool,
      actionInput,
    });
    const artifact = await publishActionArtifact({
      completion,
      adapter: createLearningStagePackageAdapter(runtime.workspaceDir),
      workspaceDir: runtime.workspaceDir,
      sessionId: runtime.sessionId,
      userId: String(runtime.userId),
    });
    assertActionArtifactPublished(completion, artifact);
    const { result: _internalResult, ...publicCompletion } = completion;
    const data: Output = {
      ...publicCompletion,
      skill_name: SKILL_NAME,
      ...(artifact
        ? {
            artifact: toPublicActionArtifactPublication(artifact),
            result: { artifact_ref: artifact.artifact_ref },
          }
        : completion.result !== undefined
          ? { result: completion.result }
          : {}),
    };
    return { data };
  },
  mapToolResultToToolResultBlockParam(
    content: Output,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      type: "tool_result",
      tool_use_id: toolUseID,
      content: JSON.stringify(content),
    };
  },
} satisfies ToolDef<InputSchema, Output>);
