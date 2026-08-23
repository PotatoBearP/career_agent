import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";
import { buildTool, type ToolDef } from "../../Tool.js";
import {
  BASELINE_ASSESSMENT_SKILL_NAME,
  BASELINE_ASSESSMENT_TOOL_NAME,
  executeBaselineAssessmentAction,
  getBaselineAssessmentCommand,
} from "../../skills/baselineAssessmentAction.js";
import {
  assertActionArtifactPublished,
  publishActionArtifact,
  toPublicActionArtifactPublication,
} from "../../artifacts/actionArtifactPublisher.js";
import { lazySchema } from "../../utils/lazySchema.js";
import { BaselineAssessmentArtifactAdapter } from "./artifactAdapter.js";
import { validateBaselineAssessmentSkillResult } from "./artifactAdapter.js";
import { registerSkillResultValidator } from "../../skills/skillResultValidation.js";

registerSkillResultValidator(BASELINE_ASSESSMENT_SKILL_NAME, (input) =>
  input.outcome === "success"
    ? validateBaselineAssessmentSkillResult(input.result)
    : { ok: true },
);

const inputSchema = lazySchema(() =>
  z.strictObject({
    assessment_target: z.string().trim().min(1).optional(),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

const outputSchema = lazySchema(() =>
  z.strictObject({
    skill_call_id: z.string(),
    skill_name: z.literal(BASELINE_ASSESSMENT_SKILL_NAME),
    agent_id: z.string(),
    execution_status: z.literal("completed"),
    outcome: z.enum(["success", "insufficient_input", "error"]),
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
        status: z.enum(["ready", "canonical_only", "error"]),
        render_mode: z.literal("html").optional(),
        error: z.string().optional(),
      })
      .optional(),
  }),
);
type OutputSchema = ReturnType<typeof outputSchema>;
type Output = z.infer<OutputSchema>;

export const BaselineAssessmentTool = buildTool({
  name: BASELINE_ASSESSMENT_TOOL_NAME,
  searchHint:
    "assess an existing evidence baseline for a role, domain, or task",
  maxResultSizeChars: 100_000,
  strict: true,
  alwaysLoad: true,
  async description() {
    return (await getBaselineAssessmentCommand()).description;
  },
  async prompt() {
    return (await getBaselineAssessmentCommand()).description;
  },
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  get outputSchema(): OutputSchema {
    return outputSchema();
  },
  userFacingName() {
    return "Baseline assessment";
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
  toAutoClassifierInput({ assessment_target }) {
    return assessment_target ?? "";
  },
  async checkPermissions(input) {
    return { behavior: "allow", updatedInput: input };
  },
  renderToolUseMessage({ assessment_target }) {
    return assessment_target
      ? `Assess baseline for ${assessment_target}`
      : "Assess baseline from existing evidence";
  },
  renderToolUseRejectedMessage() {
    return "Baseline assessment rejected";
  },
  renderToolUseErrorMessage() {
    return "Baseline assessment failed";
  },
  renderToolUseProgressMessage() {
    return "Assessing baseline";
  },
  renderToolResultMessage(output) {
    return output.summary;
  },
  async call(input, context, canUseTool) {
    const completion = await executeBaselineAssessmentAction({
      assessmentTarget: input.assessment_target,
      context,
      canUseTool,
    });
    const artifact = await publishActionArtifact({
      completion,
      adapter: BaselineAssessmentArtifactAdapter,
      workspaceDir:
        context.actionArtifactRuntime?.workspaceDir ?? process.cwd(),
      sessionId:
        context.actionArtifactRuntime?.sessionId ?? completion.skill_call_id,
      userId: context.actionArtifactRuntime?.userId ?? null,
    });
    assertActionArtifactPublished(completion, artifact);
    const { result: _internalResult, ...publicCompletion } = completion;
    const data: Output = {
      ...publicCompletion,
      skill_name: BASELINE_ASSESSMENT_SKILL_NAME,
      ...(artifact
        ? {
            artifact: toPublicActionArtifactPublication(artifact),
            result: { artifact_ref: artifact.artifact_ref },
          }
        : completion.result !== undefined
          ? { result: completion.result }
          : {}),
    };
    return {
      data,
    };
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
