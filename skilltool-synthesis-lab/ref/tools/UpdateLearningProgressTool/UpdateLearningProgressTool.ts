import { z } from "zod/v4";
import { buildTool, type ToolDef } from "../../Tool.js";
import { lazySchema } from "../../utils/lazySchema.js";
import { resolveArtifactForWorkspace } from "../../artifacts/actionArtifactResolver.js";
import {
  learningStateService,
  type LearningPlanState,
} from "../../learning/learningStateService.js";

const ref = z.string().regex(/^artifact:\/\/[0-9a-f-]{36}$/i);
const inputSchema = lazySchema(() =>
  z.discriminatedUnion("operation", [
    z.strictObject({
      plan_id: z.string().min(1),
      operation: z.literal("start_stage"),
      stage_package_ref: ref,
    }),
    z.strictObject({
      plan_id: z.string().min(1),
      operation: z.literal("mark_ready_for_assessment"),
    }),
    z.strictObject({
      plan_id: z.string().min(1),
      operation: z.literal("apply_assessment"),
      assessment_ref: ref,
      decision: z.enum(["continue", "advance", "hold"]),
    }),
    z.strictObject({
      plan_id: z.string().min(1),
      operation: z.literal("pause_plan"),
    }),
  ]),
);
type InputSchema = ReturnType<typeof inputSchema>;
const outputSchema = lazySchema(() =>
  z.strictObject({
    updated: z.literal(true),
    operation: z.enum([
      "start_stage",
      "mark_ready_for_assessment",
      "apply_assessment",
      "pause_plan",
    ]),
    operation_status: z.enum(["applied", "already_applied"]),
    plan_id: z.string(),
    plan_status: z.enum(["active", "paused", "completed", "archived"]),
    current_stage_id: z.string().nullable(),
    current_stage_status: z
      .enum(["not_started", "in_progress", "ready_for_assessment", "completed"])
      .nullable(),
    completed_stage_ids: z.array(z.string()),
    current_stage_package_ref: z.string().nullable(),
    latest_assessment_ref: z.string().nullable(),
    focus: z.boolean(),
  }),
);
type OutputSchema = ReturnType<typeof outputSchema>;
type Output = z.infer<OutputSchema>;
type ProgressTransactionValue = {
  plan: LearningPlanState;
  status: "applied" | "already_applied";
};

const stagePackageSchema = z
  .object({
    artifact_type: z.literal("LearningStagePackage"),
    package: z
      .object({ plan_id: z.string(), plan_ref: ref, stage_id: z.string() })
      .passthrough(),
  })
  .passthrough();
const assessmentSchema = z
  .object({
    artifact_type: z.literal("LearningProgressAssessment"),
    assessment: z
      .object({
        plan_id: z.string(),
        plan_ref: ref,
        stage_id: z.string(),
        readiness: z.enum(["continue", "advance", "revise", "uncertain"]),
      })
      .passthrough(),
  })
  .passthrough();
const planSchema = z
  .object({
    artifact_type: z.literal("LearningPlan"),
    plan: z
      .object({ stages: z.array(z.object({ id: z.string().min(1) })).min(1) })
      .passthrough(),
  })
  .passthrough();

function assertActive(plan: LearningPlanState): void {
  if (plan.status === "completed")
    throw new Error("PLAN_ALREADY_COMPLETED: Learning plan is completed");
  if (plan.status !== "active")
    throw new Error("PLAN_NOT_ACTIVE: Learning plan is not active");
}

export const UpdateLearningProgressTool = buildTool({
  name: "UpdateLearningProgress",
  searchHint: "apply a validated learning-stage state transition",
  maxResultSizeChars: 20_000,
  strict: true,
  alwaysLoad: true,
  async description() {
    return "Apply one deterministic transition to an activated learning plan: start_stage, mark_ready_for_assessment, apply_assessment, or pause_plan. When a user submits current-stage work for assessment, first call mark_ready_for_assessment, then call LearningProgressAssessment, then apply_assessment using that artifact and its readiness decision. This tool does not assess mastery or choose the decision.";
  },
  async prompt() {
    return "Use only after the relevant package/assessment and the user workflow decision exist. Pass opaque artifact:// references; never physical paths.";
  },
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  get outputSchema(): OutputSchema {
    return outputSchema();
  },
  userFacingName() {
    return "Update learning progress";
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
    return "Updating learning progress";
  },
  renderToolUseErrorMessage() {
    return "Learning progress update failed";
  },
  renderToolResultMessage(output) {
    return `Learning progress ${output.operation_status}`;
  },
  async call(input, context) {
    const runtime = context.actionArtifactRuntime;
    if (!runtime?.userId)
      throw new Error(
        "ARTIFACT_ACCESS_DENIED: Authenticated user workspace required",
      );
    const userId = String(runtime.userId);
    let stagePackage: z.infer<typeof stagePackageSchema> | undefined;
    let assessment: z.infer<typeof assessmentSchema> | undefined;
    let planStages: string[] | undefined;
    if (input.operation === "start_stage") {
      const artifact = await resolveArtifactForWorkspace({
        userId,
        workspaceDir: runtime.workspaceDir,
        artifactRef: input.stage_package_ref,
        expectedType: "LearningStagePackage",
        supportedSchemaVersions: ["1.0"],
      });
      try {
        stagePackage = stagePackageSchema.parse(artifact.canonical);
      } catch {
        throw new Error("STAGE_PACKAGE_MISMATCH: Stage package is invalid");
      }
    }
    if (input.operation === "apply_assessment") {
      const artifact = await resolveArtifactForWorkspace({
        userId,
        workspaceDir: runtime.workspaceDir,
        artifactRef: input.assessment_ref,
        expectedType: "LearningProgressAssessment",
        supportedSchemaVersions: ["1.0"],
      });
      try {
        assessment = assessmentSchema.parse(artifact.canonical);
      } catch {
        throw new Error("ASSESSMENT_MISMATCH: Assessment is invalid");
      }
      if (
        input.decision === "advance" &&
        assessment.assessment.readiness !== "advance"
      )
        throw new Error(
          "ASSESSMENT_NOT_READY_FOR_ADVANCE: Assessment does not support advance",
        );
      const current = await learningStateService.getPlanState(
        runtime.workspaceDir,
        input.plan_id,
      );
      if (!current)
        throw new Error("PLAN_NOT_FOUND: Learning plan was not found");
      const planArtifact = await resolveArtifactForWorkspace({
        userId,
        workspaceDir: runtime.workspaceDir,
        artifactRef: current.plan_ref,
        expectedType: "LearningPlan",
        supportedSchemaVersions: ["1.0"],
      });
      try {
        planStages = planSchema
          .parse(planArtifact.canonical)
          .plan.stages.map((stage) => stage.id);
      } catch {
        throw new Error("INVALID_PLAN_STRUCTURE: Active plan is invalid");
      }
    }
    const now = new Date().toISOString();
    const tx = await learningStateService.transact<ProgressTransactionValue>(
      runtime.workspaceDir,
      (state) => {
        const index = state.plans.findIndex(
          (plan) => plan.plan_id === input.plan_id,
        );
        if (index < 0)
          throw new Error("PLAN_NOT_FOUND: Learning plan was not found");
        const current = state.plans[index]!;
        let next = current;
        let already = false;
        if (input.operation === "pause_plan") {
          if (current.status === "paused") already = true;
          else {
            assertActive(current);
            next = { ...current, status: "paused", updated_at: now };
          }
        } else if (input.operation === "start_stage") {
          assertActive(current);
          if (!current.current_stage_id)
            throw new Error(
              "CURRENT_STAGE_NOT_FOUND: Current stage is missing",
            );
          if (
            stagePackage!.package.plan_id !== current.plan_id ||
            stagePackage!.package.plan_ref !== current.plan_ref ||
            stagePackage!.package.stage_id !== current.current_stage_id
          )
            throw new Error(
              "STAGE_PACKAGE_MISMATCH: Stage package does not match current plan and stage",
            );
          if (
            current.current_stage_status === "in_progress" &&
            current.current_stage_package_ref === input.stage_package_ref
          )
            already = true;
          else if (current.current_stage_status !== "not_started")
            throw new Error(
              "INVALID_STAGE_STATE: Current stage cannot be started",
            );
          else
            next = {
              ...current,
              current_stage_status: "in_progress",
              current_stage_package_ref: input.stage_package_ref,
              updated_at: now,
            };
        } else if (input.operation === "mark_ready_for_assessment") {
          assertActive(current);
          if (current.current_stage_status === "ready_for_assessment")
            already = true;
          else if (current.current_stage_status !== "in_progress")
            throw new Error(
              "INVALID_STAGE_STATE: Current stage is not in progress",
            );
          else if (!current.current_stage_package_ref)
            throw new Error("NO_STAGE_PACKAGE: Current stage has no package");
          else
            next = {
              ...current,
              current_stage_status: "ready_for_assessment",
              updated_at: now,
            };
        } else {
          assertActive(current);
          const assessed = assessment!.assessment;
          if (
            assessed.plan_id !== current.plan_id ||
            assessed.plan_ref !== current.plan_ref
          )
            throw new Error(
              "ASSESSMENT_MISMATCH: Assessment does not match current plan",
            );
          const duplicate =
            input.assessment_ref === current.latest_assessment_ref;
          if (input.decision === "continue") {
            if (duplicate && current.current_stage_status === "in_progress")
              already = true;
            else if (
              current.current_stage_id !== assessed.stage_id ||
              current.current_stage_status !== "ready_for_assessment"
            )
              throw new Error(
                "INVALID_STAGE_STATE: Assessment cannot be applied to current stage",
              );
            else
              next = {
                ...current,
                current_stage_status: "in_progress",
                latest_assessment_ref: input.assessment_ref,
                updated_at: now,
              };
          } else if (input.decision === "hold") {
            if (
              duplicate &&
              current.current_stage_status === "ready_for_assessment"
            )
              already = true;
            else if (
              current.current_stage_id !== assessed.stage_id ||
              current.current_stage_status !== "ready_for_assessment"
            )
              throw new Error(
                "INVALID_STAGE_STATE: Assessment cannot be held on current stage",
              );
            else
              next = {
                ...current,
                latest_assessment_ref: input.assessment_ref,
                updated_at: now,
              };
          } else {
            if (
              duplicate &&
              current.completed_stage_ids.includes(assessed.stage_id)
            )
              already = true;
            else if (
              current.current_stage_id !== assessed.stage_id ||
              current.current_stage_status !== "ready_for_assessment"
            )
              throw new Error(
                "INVALID_STAGE_STATE: Current stage is not ready to advance",
              );
            else {
              const stageIndex = planStages!.indexOf(current.current_stage_id);
              if (stageIndex < 0)
                throw new Error(
                  "INVALID_PLAN_STRUCTURE: Current stage is absent from plan",
                );
              const completed = [
                ...new Set([
                  ...current.completed_stage_ids,
                  current.current_stage_id,
                ]),
              ];
              const nextId = planStages![stageIndex + 1];
              next = nextId
                ? {
                    ...current,
                    completed_stage_ids: completed,
                    current_stage_id: nextId,
                    current_stage_status: "not_started",
                    current_stage_package_ref: null,
                    latest_assessment_ref: input.assessment_ref,
                    updated_at: now,
                  }
                : {
                    ...current,
                    status: "completed",
                    completed_stage_ids: completed,
                    current_stage_status: "completed",
                    latest_assessment_ref: input.assessment_ref,
                    updated_at: now,
                  };
            }
          }
        }
        if (already)
          return {
            state,
            value: { plan: current, status: "already_applied" as const },
            changed: false,
          };
        const plans = [...state.plans];
        plans[index] = next;
        return {
          state: { ...state, plans },
          value: { plan: next, status: "applied" as const },
          changed: true,
        };
      },
    );
    const plan = tx.value.plan;
    const data: Output = {
      updated: true,
      operation: input.operation,
      operation_status: tx.value.status,
      plan_id: plan.plan_id,
      plan_status: plan.status,
      current_stage_id: plan.current_stage_id,
      current_stage_status: plan.current_stage_status,
      completed_stage_ids: plan.completed_stage_ids,
      current_stage_package_ref: plan.current_stage_package_ref,
      latest_assessment_ref: plan.latest_assessment_ref,
      focus: tx.state.focus_plan_id === plan.plan_id,
    };
    return { data };
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      type: "tool_result",
      tool_use_id: toolUseID,
      content: JSON.stringify(content),
    };
  },
} satisfies ToolDef<InputSchema, Output>);
