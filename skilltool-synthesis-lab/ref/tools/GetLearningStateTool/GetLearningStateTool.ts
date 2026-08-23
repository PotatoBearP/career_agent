import { z } from "zod/v4";
import { buildTool, type ToolDef } from "../../Tool.js";
import { lazySchema } from "../../utils/lazySchema.js";
import { learningStateService } from "../../learning/learningStateService.js";

const inputSchema = lazySchema(() =>
  z.strictObject({ plan_id: z.string().trim().min(1).optional() }),
);
type InputSchema = ReturnType<typeof inputSchema>;
const planSchema = z.strictObject({
  plan_id: z.string(),
  plan_ref: z.string(),
  plan_artifact_uid: z.string(),
  status: z.enum(["active", "paused", "completed", "archived"]),
  current_stage_id: z.string().nullable(),
  current_stage_status: z
    .enum(["not_started", "in_progress", "ready_for_assessment", "completed"])
    .nullable(),
  completed_stage_ids: z.array(z.string()),
  current_stage_package_ref: z.string().nullable(),
  latest_assessment_ref: z.string().nullable(),
  focus: z.boolean(),
  activated_at: z.string(),
  updated_at: z.string(),
});
const outputSchema = lazySchema(() =>
  z.strictObject({
    schema_version: z.literal("1.0"),
    state_version: z.number().int().nonnegative(),
    focus_plan_id: z.string().nullable(),
    plans: z.array(planSchema),
  }),
);
type OutputSchema = ReturnType<typeof outputSchema>;

export const GetLearningStateTool = buildTool({
  name: "GetLearningState",
  searchHint: "read active learning plans and current stage state",
  maxResultSizeChars: 30_000,
  strict: true,
  alwaysLoad: true,
  async description() {
    return "Read the current user’s lightweight learning workflow state. Optionally select one plan_id. This does not read full artifacts or modify state. For an active plan execution request, pass the returned plan_id directly to LearningStageDesign; that Action resolves plan_ref internally.";
  },
  async prompt() {
    return "Use this to determine the current learning plan or stage. Artifact references are opaque and are consumed internally by the appropriate Action Tool. Do not use Bash, Glob, Read, or filesystem search to locate learning state or artifact files. After finding the focus plan, call LearningStageDesign directly with its plan_id when a stage package is needed.";
  },
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  get outputSchema(): OutputSchema {
    return outputSchema();
  },
  userFacingName() {
    return "Learning state";
  },
  isEnabled() {
    return true;
  },
  isConcurrencySafe() {
    return true;
  },
  isReadOnly() {
    return true;
  },
  toAutoClassifierInput(input) {
    return JSON.stringify(input);
  },
  async checkPermissions(input) {
    return { behavior: "allow", updatedInput: input };
  },
  renderToolUseMessage() {
    return "Reading learning state";
  },
  renderToolUseErrorMessage() {
    return "Could not read learning state";
  },
  renderToolResultMessage(output) {
    return `${output.plans.length} learning plan${output.plans.length === 1 ? "" : "s"}`;
  },
  async call(input, context) {
    const workspaceDir = context.actionArtifactRuntime?.workspaceDir;
    if (!workspaceDir)
      throw new Error(
        "STATE_READ_FAILED: Learning state is unavailable outside an authenticated workspace",
      );
    const state = await learningStateService.getUserState(workspaceDir);
    const plans = input.plan_id
      ? state.plans.filter((plan) => plan.plan_id === input.plan_id)
      : state.plans;
    if (input.plan_id && plans.length === 0)
      throw new Error("PLAN_NOT_FOUND: Learning plan was not found");
    return {
      data: {
        schema_version: "1.0" as const,
        state_version: state.version,
        focus_plan_id: state.focus_plan_id,
        plans: plans.map((plan) => ({
          ...plan,
          focus: plan.plan_id === state.focus_plan_id,
        })),
      },
    };
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      type: "tool_result",
      tool_use_id: toolUseID,
      content: JSON.stringify(content),
    };
  },
} satisfies ToolDef<InputSchema, z.infer<OutputSchema>>);
