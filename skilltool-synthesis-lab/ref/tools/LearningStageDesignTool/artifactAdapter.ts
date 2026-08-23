import { readFile } from 'node:fs/promises'
import { z } from 'zod/v4'
import { resolveActionSkillArtifactPath, type ActionArtifactAdapter } from '../../artifacts/actionArtifactPublisher.js'

const packageSchema = z.strictObject({
  schema_version: z.literal('1.0'), artifact_type: z.literal('LearningStagePackage'),
  created_at: z.string().datetime({ offset: true }),
  package: z.strictObject({
    plan_id: z.string().min(1), plan_ref: z.string().regex(/^artifact:\/\/[0-9a-f-]{36}$/i),
    plan_version: z.number().int().positive(), stage_id: z.string().min(1), stage_name: z.string().min(1),
    stage_goal: z.string().min(1), constraints: z.record(z.string(), z.string()),
    objectives: z.array(z.strictObject({ id: z.string().min(1), description: z.string().min(1),
      competency_refs: z.array(z.string().min(1)), completion_criteria: z.array(z.string().min(1)).min(1) })).min(1),
    sequence: z.array(z.strictObject({ order: z.number().int().positive(), title: z.string().min(1),
      objective_refs: z.array(z.string().min(1)).min(1), content_scope: z.array(z.string().min(1)).min(1),
      learning_activities: z.array(z.string().min(1)).min(1), practice_tasks: z.array(z.string().min(1)).min(1),
      resources: z.array(z.strictObject({ title: z.string().min(1), url: z.string().url(), source_type: z.string().min(1), purpose: z.string().min(1) })),
      expected_outputs: z.array(z.string().min(1)).min(1) })).min(1),
    assessment: z.strictObject({ method: z.string().min(1), expected_evidence: z.array(z.string().min(1)).min(1),
      completion_criteria: z.array(z.strictObject({ objective_ref: z.string().min(1), criterion: z.string().min(1), required: z.boolean() })).min(1) }),
    limitations: z.array(z.string()),
  }),
}).superRefine((artifact, ctx) => {
  const objectives = new Set(artifact.package.objectives.map(item => item.id))
  if (objectives.size !== artifact.package.objectives.length) ctx.addIssue({ code: 'custom', path: ['package', 'objectives'], message: 'Duplicate objective ID' })
  const orders = new Set(artifact.package.sequence.map(item => item.order))
  if (orders.size !== artifact.package.sequence.length) ctx.addIssue({ code: 'custom', path: ['package', 'sequence'], message: 'Duplicate sequence order' })
  for (const [i, unit] of artifact.package.sequence.entries()) for (const ref of unit.objective_refs) {
    if (!objectives.has(ref)) ctx.addIssue({ code: 'custom', path: ['package', 'sequence', i, 'objective_refs'], message: 'Unknown objective ref' })
  }
  for (const [i, criterion] of artifact.package.assessment.completion_criteria.entries()) {
    if (!objectives.has(criterion.objective_ref)) ctx.addIssue({ code: 'custom', path: ['package', 'assessment', 'completion_criteria', i], message: 'Unknown objective ref' })
  }
})
type StagePackageSource = z.infer<typeof packageSchema>
export type LearningStagePackageArtifact = { schema_version: '1.0'; artifact_type: 'LearningStagePackage'; created_at: string;
  lineage: { skill_call_id: string; skill_name: string; agent_id: string }; package: StagePackageSource['package'] }

function escapeHtml(value: unknown): string { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;') }
export function createLearningStagePackageAdapter(workspaceDir: string): ActionArtifactAdapter<LearningStagePackageArtifact> {
  return { artifactType: 'learning-stage-package', artifactSlug: 'learning-stage-package', schemaVersion: '1.0',
    async toCanonical(completion) {
      const path = await resolveActionSkillArtifactPath({ completion, workspaceDir, artifactType: 'LearningStagePackage' })
      const source = packageSchema.parse(JSON.parse(await readFile(path, 'utf8')))
      return { schema_version: '1.0', artifact_type: 'LearningStagePackage', created_at: completion.completed_at,
        lineage: { skill_call_id: completion.skill_call_id, skill_name: completion.skill_name, agent_id: completion.agent_id }, package: source.package }
    },
    render(artifact) {
      const pkg = artifact.package
      const objectives = pkg.objectives.map(item => `<li><strong>${escapeHtml(item.description)}</strong><br><span>${item.completion_criteria.map(escapeHtml).join('；')}</span></li>`).join('')
      const units = [...pkg.sequence].sort((a,b) => a.order-b.order).map(unit => `<article><h3>${unit.order}. ${escapeHtml(unit.title)}</h3><p>${unit.content_scope.map(escapeHtml).join(' · ')}</p><h4>实践</h4><ul>${unit.practice_tasks.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul><h4>资料</h4><ul>${unit.resources.map(item => `<li><a href="${escapeHtml(item.url)}" rel="noreferrer">${escapeHtml(item.title)}</a> — ${escapeHtml(item.purpose)}</li>`).join('')}</ul></article>`).join('')
      return { title: `${pkg.stage_name} · 阶段学习方案`, summary: pkg.stage_goal, renderMode: 'html',
        html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(pkg.stage_name)}</title><style>body{font:15px/1.65 system-ui;background:#f4f7f5;color:#17211f;margin:0;padding:28px}main{max-width:960px;margin:auto}header,section,article{background:white;border:1px solid #dce6e1;border-radius:16px;padding:20px;margin:0 0 16px}h1,h2,h3,h4{margin-top:0}a{color:#276755}</style></head><body><main><header><p>Learning Stage Package</p><h1>${escapeHtml(pkg.stage_name)}</h1><p>${escapeHtml(pkg.stage_goal)}</p></header><section><h2>学习目标</h2><ul>${objectives}</ul></section><section><h2>执行顺序</h2>${units}</section><section><h2>验收</h2><p>${escapeHtml(pkg.assessment.method)}</p><ul>${pkg.assessment.expected_evidence.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section></main></body></html>` }
    } }
}
