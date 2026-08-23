import { z } from "zod/v4";
import type {
  ActionArtifactAdapter,
  ActionCompletionForArtifact,
} from "../../artifacts/actionArtifactPublisher.js";
import type { JsonValue } from "../../skills/skillLifecycleTypes.js";

const abilityLevelSchema = z.enum([
  "awareness",
  "foundational",
  "applied",
  "independent",
  "advanced",
]);
const confidenceSchema = z.enum(["low", "medium", "high"]);

const evidenceSchema = z.object({
  summary: z.string(),
  source_type: z.enum([
    "conversation",
    "profile",
    "tool_result",
    "mcp_result",
    "skill_result",
    "artifact",
  ]),
  source_ref: z.string().optional(),
});

const baselineAssessmentSchema = z.object({
  assessment_target: z.object({
    name: z.string(),
    basis: z.enum(["explicit", "inferred"]),
    scope: z.string(),
  }),
  framework: z.object({
    source: z.enum(["provided", "model_derived"]),
    summary: z.string(),
  }),
  overall: z.object({
    level: abilityLevelSchema,
    confidence: confidenceSchema,
    summary: z.string(),
  }),
  capabilities: z.array(
    z.object({
      dimension: z.string(),
      level: abilityLevelSchema,
      confidence: confidenceSchema,
      evidence_basis: z.array(
        z.enum(["demonstrated", "documented", "self_reported", "inferred"]),
      ),
      evidence: z.array(evidenceSchema),
      assessment: z.string(),
    }),
  ),
  unknowns: z.array(
    z.object({
      dimension: z.string(),
      reason: z.string(),
    }),
  ),
  conflicts: z.array(
    z.object({
      dimension: z.string(),
      summary: z.string(),
      impact: z.string(),
    }),
  ),
  limitations: z.array(z.string()),
});

export function validateBaselineAssessmentSkillResult(
  result: JsonValue | undefined,
): { ok: true } | { ok: false; error: string } {
  let candidate: unknown = result;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return {
        ok: false,
        error:
          "BaselineAssessment success result must be a JSON object, not an encoded or invalid string. Correct the result and call ReturnSkillResult again.",
      };
    }
  }
  const parsed = baselineAssessmentSchema.safeParse(candidate);
  if (parsed.success) return { ok: true };
  const fields = [
    ...new Set(
      parsed.error.issues.map((issue) =>
        issue.path.length ? issue.path.join(".") : "result",
      ),
    ),
  ].slice(0, 8);
  return {
    ok: false,
    error: `BaselineAssessment success result is incomplete or invalid at: ${fields.join(", ")}. Correct these fields and call ReturnSkillResult again.`,
  };
}

type BaselineAssessment = z.infer<typeof baselineAssessmentSchema>;

export type BaselineAssessmentArtifact = {
  schema_version: "1.0";
  artifact_type: "BaselineAssessment";
  created_at: string;
  lineage: {
    skill_call_id: string;
    skill_name: string;
    agent_id: string;
  };
  assessment: BaselineAssessment;
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function list(items: string[], emptyText: string): string {
  if (!items.length) return `<p class="empty">${escapeHtml(emptyText)}</p>`;
  return `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
}

function toCanonical(
  completion: ActionCompletionForArtifact,
): BaselineAssessmentArtifact {
  let result: unknown = completion.result;
  if (typeof result === "string") {
    try {
      result = JSON.parse(result);
    } catch {
      // Preserve the original value so the schema reports the canonical error.
    }
  }
  const assessment = baselineAssessmentSchema.parse(result);
  return {
    schema_version: "1.0",
    artifact_type: "BaselineAssessment",
    created_at: completion.completed_at,
    lineage: {
      skill_call_id: completion.skill_call_id,
      skill_name: completion.skill_name,
      agent_id: completion.agent_id,
    },
    assessment,
  };
}

function renderCapability(
  capability: BaselineAssessment["capabilities"][number],
) {
  const evidence = capability.evidence.map((item) => {
    const reference = item.source_ref
      ? ` <span class="source-ref">${escapeHtml(item.source_ref)}</span>`
      : "";
    return `${escapeHtml(item.summary)}${reference}`;
  });
  return `
    <article class="capability">
      <div class="capability-head">
        <h3>${escapeHtml(capability.dimension)}</h3>
        <div class="badges">
          <span class="badge level">${escapeHtml(capability.level)}</span>
          <span class="badge confidence confidence-${escapeHtml(capability.confidence)}">置信度 ${escapeHtml(capability.confidence)}</span>
        </div>
      </div>
      <p>${escapeHtml(capability.assessment)}</p>
      <p class="basis">证据性质：${escapeHtml(capability.evidence_basis.join(" · "))}</p>
      ${list(evidence, "没有列出证据摘要。")}
    </article>`;
}

function renderBaselineAssessmentHtml(
  artifact: BaselineAssessmentArtifact,
): string {
  const assessment = artifact.assessment;
  const unknowns = assessment.unknowns.map(
    (item) =>
      `<strong>${escapeHtml(item.dimension)}</strong>：${escapeHtml(item.reason)}`,
  );
  const conflicts = assessment.conflicts.map(
    (item) =>
      `<strong>${escapeHtml(item.dimension)}</strong>：${escapeHtml(item.summary)}<br><span class="muted">影响：${escapeHtml(item.impact)}</span>`,
  );
  const limitations = assessment.limitations.map((item) => escapeHtml(item));

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(assessment.assessment_target.name)} · 能力基线评估</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17211f; background: #f4f7f5; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 28px; line-height: 1.6; }
    main { max-width: 980px; margin: 0 auto; }
    header, section { background: #fff; border: 1px solid #dce6e1; border-radius: 18px; padding: 22px; margin-bottom: 16px; box-shadow: 0 8px 28px rgba(26, 58, 48, .06); }
    .eyebrow { margin: 0 0 6px; color: #397363; font-size: 12px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    h1, h2, h3, p { margin-top: 0; }
    h1 { margin-bottom: 8px; font-size: clamp(25px, 4vw, 38px); line-height: 1.2; }
    h2 { margin-bottom: 14px; font-size: 20px; }
    h3 { margin-bottom: 0; font-size: 17px; }
    .scope, .muted, .basis, .empty { color: #64736f; }
    .overall { display: grid; grid-template-columns: minmax(150px, .35fr) 1fr; gap: 18px; align-items: stretch; }
    .overall-level { display: flex; flex-direction: column; justify-content: center; border-radius: 14px; padding: 18px; background: #e9f4ef; }
    .overall-level strong { font-size: 25px; color: #245f50; }
    .capability { padding: 17px 0; border-top: 1px solid #e6ece9; }
    .capability:first-of-type { border-top: 0; padding-top: 0; }
    .capability:last-of-type { padding-bottom: 0; }
    .capability-head { display: flex; gap: 12px; justify-content: space-between; align-items: flex-start; }
    .badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 7px; }
    .badge { display: inline-flex; padding: 4px 9px; border-radius: 999px; background: #edf1ef; font-size: 12px; font-weight: 750; white-space: nowrap; }
    .badge.level { color: #fff; background: #397363; }
    .confidence-low { color: #8a5019; background: #fff0dd; }
    .confidence-medium { color: #315f78; background: #e6f3fa; }
    .confidence-high { color: #245f50; background: #e3f4ec; }
    ul { margin: 8px 0 0; padding-left: 21px; }
    li + li { margin-top: 6px; }
    .source-ref { display: inline-block; margin-left: 4px; padding: 1px 6px; border-radius: 6px; background: #edf1ef; color: #52615d; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .grid section { margin: 0; }
    @media (max-width: 700px) { body { padding: 14px; } .overall, .grid { grid-template-columns: 1fr; } .capability-head { flex-direction: column; } .badges { justify-content: flex-start; } }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Baseline Assessment</p>
      <h1>${escapeHtml(assessment.assessment_target.name)}</h1>
      <p class="scope">${escapeHtml(assessment.assessment_target.scope)}</p>
      <p class="muted">评估框架：${escapeHtml(assessment.framework.source)} · ${escapeHtml(assessment.framework.summary)}</p>
    </header>
    <section>
      <h2>总体基线</h2>
      <div class="overall">
        <div class="overall-level"><span>当前水平</span><strong>${escapeHtml(assessment.overall.level)}</strong><span>置信度 ${escapeHtml(assessment.overall.confidence)}</span></div>
        <p>${escapeHtml(assessment.overall.summary)}</p>
      </div>
    </section>
    <section>
      <h2>能力维度</h2>
      ${assessment.capabilities.map(renderCapability).join("")}
    </section>
    <div class="grid">
      <section><h2>尚未评估</h2>${list(unknowns, "没有列出关键未知项。")}</section>
      <section><h2>冲突证据</h2>${list(conflicts, "没有发现需要保留的冲突。")}</section>
    </div>
    <section><h2>限制</h2>${list(limitations, "没有额外限制。")}</section>
  </main>
</body>
</html>`;
}

export const BaselineAssessmentArtifactAdapter = {
  artifactType: "baseline-assessment",
  artifactSlug: "baseline-assessment",
  schemaVersion: "1.0",
  toCanonical,
  render(artifact) {
    return {
      title: `${artifact.assessment.assessment_target.name} · 能力基线评估`,
      summary: artifact.assessment.overall.summary,
      renderMode: "html",
      html: renderBaselineAssessmentHtml(artifact),
    };
  },
} satisfies ActionArtifactAdapter<BaselineAssessmentArtifact & JsonValue>;
