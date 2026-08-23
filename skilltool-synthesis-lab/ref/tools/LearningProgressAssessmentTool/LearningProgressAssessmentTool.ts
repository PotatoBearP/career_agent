import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool, type ToolDef } from "../../Tool.js";
import { lazySchema } from "../../utils/lazySchema.js";
import {
  executeSkillAction,
  getSkillActionCommand,
} from "../../skills/skillAction.js";
import { learningStateService } from "../../learning/learningStateService.js";
import { resolveArtifactForWorkspace } from "../../artifacts/actionArtifactResolver.js";
import {
  assertActionArtifactPublished,
  publishActionArtifact,
  toPublicActionArtifactPublication,
} from "../../artifacts/actionArtifactPublisher.js";
import { createLearningProgressAssessmentAdapter } from "./artifactAdapter.js";
const SKILL_NAME = "learning-progress-assessment" as const;
const evidenceSchema = z.strictObject({
  source_type: z.enum([
    "conversation",
    "artifact",
    "workspace_file",
    "tool_result",
    "mcp_result",
  ]),
  source_ref: z.string().trim().min(1).optional(),
  summary: z.string().trim().min(1),
});
const inputSchema = lazySchema(() =>
  z.strictObject({
    plan_id: z.string().trim().min(1).optional(),
    evidence: z.array(evidenceSchema).min(1),
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
function contextText(context: unknown): string {
  try {
    return JSON.stringify((context as { messages?: unknown }).messages ?? []);
  } catch {
    return "";
  }
}
export const LearningProgressAssessmentTool = buildTool({
  name: "LearningProgressAssessment",
  searchHint:
    "assess already-visible work against the current learning stage rubric",
  maxResultSizeChars: 100_000,
  strict: true,
  alwaysLoad: true,
  async description() {
    return `${(await getSkillActionCommand(SKILL_NAME)).description} Prerequisite: read LearningState and, when the current stage is in_progress and the user has submitted the stage work for judgment, call UpdateLearningProgress with operation="mark_ready_for_assessment" before calling this tool. After this tool returns a ready artifact, apply its readiness decision with UpdateLearningProgress.`;
  },
  async prompt() {
    return `${(await getSkillActionCommand(SKILL_NAME)).description} This assessment is valid only while current_stage_status is ready_for_assessment; use the deterministic progress tool for state transitions.`;
  },
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  get outputSchema(): OutputSchema {
    return outputSchema();
  },
  userFacingName() {
    return "Learning progress assessment";
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
    return "Assess current learning evidence";
  },
  renderToolUseRejectedMessage() {
    return "Learning progress assessment rejected";
  },
  renderToolUseErrorMessage() {
    return "Learning progress assessment failed";
  },
  renderToolUseProgressMessage() {
    return "Assessing learning progress";
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
    if (!planId) throw new Error("PLAN_NOT_FOUND: No focus plan");
    const ps = state.plans.find((p) => p.plan_id === planId);
    if (!ps) throw new Error("PLAN_NOT_FOUND: Learning plan was not found");
    if (!ps.current_stage_id)
      throw new Error("CURRENT_STAGE_NOT_FOUND: Current stage is missing");
    if (!ps.current_stage_package_ref)
      throw new Error("NO_STAGE_PACKAGE: Current stage has no package");
    if (ps.current_stage_status !== "ready_for_assessment")
      throw new Error(
        'STAGE_NOT_READY_FOR_ASSESSMENT: Mark the current stage ready_for_assessment with UpdateLearningProgress before assessing it',
      );
    const userId = String(runtime.userId);
    const plan = (
      await resolveArtifactForWorkspace({
        userId,
        workspaceDir: runtime.workspaceDir,
        artifactRef: ps.plan_ref,
        expectedType: "LearningPlan",
        supportedSchemaVersions: ["1.0"],
      })
    ).canonical;
    const stagePackage = (
      await resolveArtifactForWorkspace({
        userId,
        workspaceDir: runtime.workspaceDir,
        artifactRef: ps.current_stage_package_ref,
        expectedType: "LearningStagePackage",
        supportedSchemaVersions: ["1.0"],
      })
    ).canonical;
    const prior = ps.latest_assessment_ref
      ? (
          await resolveArtifactForWorkspace({
            userId,
            workspaceDir: runtime.workspaceDir,
            artifactRef: ps.latest_assessment_ref,
            expectedType: "LearningProgressAssessment",
            supportedSchemaVersions: ["1.0"],
          })
        ).canonical
      : null;
    const before = contextText(context);
    const descriptors = input.evidence.map((item, index) => ({
      ...item,
      id: `input-evidence-${index + 1}`,
      visible_before_invocation: item.source_ref
        ? before.includes(item.source_ref)
        : before.includes(item.summary),
    }));
    const completion = await executeSkillAction({
      skillName: SKILL_NAME,
      context,
      canUseTool,
      actionInput: {
        plan_id: ps.plan_id,
        plan_ref: ps.plan_ref,
        current_stage_id: ps.current_stage_id,
        stage_package_ref: ps.current_stage_package_ref,
        plan,
        stage_package: stagePackage,
        previous_assessment: prior,
        evidence: descriptors,
      },
    });
    const artifact = await publishActionArtifact({
      completion,
      adapter: createLearningProgressAssessmentAdapter(runtime.workspaceDir),
      workspaceDir: runtime.workspaceDir,
      sessionId: runtime.sessionId,
      userId,
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
