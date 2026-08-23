import { readFile } from "node:fs/promises";
import { z } from "zod/v4";
import {
  resolveActionSkillArtifactPath,
  type ActionArtifactAdapter,
} from "../../artifacts/actionArtifactPublisher.js";
const evidence = z.strictObject({
  id: z.string().min(1),
  source_type: z.string().min(1),
  source_ref: z.string().min(1).optional(),
  summary: z.string().min(1),
  basis: z.enum(["demonstrated", "documented", "self_reported", "inferred"]),
});
const sourceSchema = z
  .strictObject({
    schema_version: z.literal("1.0"),
    artifact_type: z.literal("LearningProgressAssessment"),
    created_at: z.string().datetime({ offset: true }),
    assessment: z.strictObject({
      plan_id: z.string().min(1),
      plan_ref: z.string().regex(/^artifact:\/\/[0-9a-f-]{36}$/i),
      plan_version: z.number().int().positive(),
      stage_id: z.string().min(1),
      stage_package_ref: z.string().regex(/^artifact:\/\/[0-9a-f-]{36}$/i),
      evidence: z.array(evidence).min(1),
      objectives: z
        .array(
          z.strictObject({
            objective_ref: z.string().min(1),
            status: z.enum(["not_assessed", "partial", "met", "exceeded"]),
            confidence: z.enum(["low", "medium", "high"]),
            evidence_refs: z.array(z.string()),
            assessment: z.string().min(1),
            remaining_gaps: z.array(z.string()),
          }),
        )
        .min(1),
      overall: z.strictObject({
        mastery: z.enum(["insufficient", "partial", "meets", "exceeds"]),
        confidence: z.enum(["low", "medium", "high"]),
        coverage_summary: z.string().min(1),
      }),
      readiness: z.enum(["continue", "advance", "revise", "uncertain"]),
      readiness_rationale: z.string().min(1),
      limitations: z.array(z.string()),
    }),
  })
  .superRefine((v, ctx) => {
    const evidenceIds = new Set(v.assessment.evidence.map((e) => e.id));
    if (evidenceIds.size !== v.assessment.evidence.length)
      ctx.addIssue({
        code: "custom",
        path: ["assessment", "evidence"],
        message: "Duplicate evidence ID",
      });
    for (const [i, o] of v.assessment.objectives.entries())
      for (const ref of o.evidence_refs)
        if (!evidenceIds.has(ref))
          ctx.addIssue({
            code: "custom",
            path: ["assessment", "objectives", i, "evidence_refs"],
            message: "Unknown evidence ref",
          });
  });
type Source = z.infer<typeof sourceSchema>;
export type LearningProgressAssessmentArtifact = {
  schema_version: "1.0";
  artifact_type: "LearningProgressAssessment";
  created_at: string;
  lineage: { skill_call_id: string; skill_name: string; agent_id: string };
  assessment: Source["assessment"];
};
function esc(v: unknown) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
export function createLearningProgressAssessmentAdapter(
  workspaceDir: string,
): ActionArtifactAdapter<LearningProgressAssessmentArtifact> {
  return {
    artifactType: "learning-progress-assessment",
    artifactSlug: "learning-progress-assessment",
    schemaVersion: "1.0",
    async toCanonical(c) {
      const path = await resolveActionSkillArtifactPath({
        completion: c,
        workspaceDir,
        artifactType: "LearningProgressAssessment",
      });
      const s = sourceSchema.parse(JSON.parse(await readFile(path, "utf8")));
      return {
        schema_version: "1.0",
        artifact_type: "LearningProgressAssessment",
        created_at: c.completed_at,
        lineage: {
          skill_call_id: c.skill_call_id,
          skill_name: c.skill_name,
          agent_id: c.agent_id,
        },
        assessment: s.assessment,
      };
    },
    render(a) {
      const x = a.assessment;
      const rows = x.objectives
        .map(
          (o) =>
            `<tr><td>${esc(o.objective_ref)}</td><td>${esc(o.status)}</td><td>${esc(o.confidence)}</td><td>${esc(o.assessment)}</td></tr>`,
        )
        .join("");
      return {
        title: `${x.stage_id} · 学习进度评估`,
        summary: x.readiness_rationale,
        renderMode: "html",
        html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(x.stage_id)}</title><style>body{font:15px/1.65 system-ui;background:#f4f7f5;color:#17211f;padding:28px}main{max-width:960px;margin:auto}header,section{background:#fff;border:1px solid #dce6e1;border-radius:16px;padding:20px;margin-bottom:16px}table{width:100%;border-collapse:collapse}td,th{padding:10px;border-bottom:1px solid #ddd;text-align:left}.badge{display:inline-block;padding:4px 10px;border-radius:999px;background:#e4f2ec}</style></head><body><main><header><p>Learning Progress Assessment</p><h1>${esc(x.stage_id)}</h1><span class="badge">${esc(x.readiness)}</span><p>${esc(x.readiness_rationale)}</p></header><section><h2>总体判断</h2><p>${esc(x.overall.mastery)} · ${esc(x.overall.confidence)}</p><p>${esc(x.overall.coverage_summary)}</p></section><section><h2>目标评估</h2><table><thead><tr><th>目标</th><th>状态</th><th>置信度</th><th>依据</th></tr></thead><tbody>${rows}</tbody></table></section></main></body></html>`,
      };
    },
  };
}
