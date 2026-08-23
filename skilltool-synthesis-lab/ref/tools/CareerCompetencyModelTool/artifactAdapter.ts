import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod/v4'
import {
  isPathInsideWorkspace,
  type ActionArtifactAdapter,
  type ActionCompletionForArtifact,
} from '../../artifacts/actionArtifactPublisher.js'
import type { JsonValue } from '../../skills/skillLifecycleTypes.js'

const importanceSchema = z.enum(['core', 'important', 'supporting'])
const expectedDepthSchema = z.enum([
  'awareness',
  'working',
  'independent',
  'advanced',
])
const requirementCategorySchema = z.enum([
  'knowledge',
  'skill',
  'tool',
  'job_task',
  'experience',
  'credential',
])
const sourceTypeSchema = z.enum([
  'job_posting',
  'employer',
  'government',
  'professional_body',
  'official_documentation',
  'curriculum',
  'textbook',
  'paper',
  'survey',
  'other',
])

const nullableString = z.string().optional().nullable()

const careerCompetencyModelSchema = z.object({
  schema_version: z.string(),
  artifact_type: z.string(),
  created_at: z.string().optional(),
  target: z.object({
    role: z.string(),
    industry: nullableString,
    region: nullableString,
    seniority: nullableString,
    specialization: nullableString,
    scope_notes: z.array(z.string()).optional(),
  }),
  methodology: z.object({
    as_of: z.string().optional(),
    research_summary: z.string().optional(),
    source_mix: z.array(z.string()).optional(),
  }),
  requirements: z
    .array(
      z.object({
        id: z.string(),
        category: requirementCategorySchema,
        statement: z.string(),
        source_refs: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  job_tasks: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().optional(),
        source_refs: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  competency_domains: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      definition: z.string().optional(),
      competencies: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          definition: z.string().optional(),
          importance: importanceSchema,
          expected_depth: expectedDepthSchema,
          requirement_refs: z.array(z.string()).optional(),
          related_job_task_refs: z.array(z.string()).optional(),
          evidence_refs: z.array(z.string()).optional(),
        }),
      ),
    }),
  ),
  relationships: z
    .array(
      z.object({
        from_competency_ref: z.string(),
        to_competency_ref: z.string(),
        type: z.enum(['prerequisite', 'part_of']),
        rationale: z.string().optional(),
      }),
    )
    .optional(),
  sources: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        url: z.string().optional(),
        publisher: z.string().optional(),
        source_type: sourceTypeSchema,
        published_or_updated_at: nullableString,
        accessed_at: z.string().optional(),
        relevance: z.string().optional(),
      }),
    )
    .optional(),
  limitations: z.array(z.string()).optional(),
})

type CareerCompetencyModel = z.infer<typeof careerCompetencyModelSchema>

export type CareerCompetencyModelArtifact = {
  schema_version: '1.0'
  artifact_type: 'CareerCompetencyModel'
  created_at: string
  lineage: {
    skill_call_id: string
    skill_name: string
    agent_id: string
  }
  model: CareerCompetencyModel
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function list(items: string[], emptyText: string): string {
  if (!items.length) return `<p class="empty">${escapeHtml(emptyText)}</p>`
  return `<ul>${items.map(item => `<li>${item}</li>`).join('')}</ul>`
}

function resolveModelPath(result: unknown, workspaceDir: string): string {
  const artifact = (result as { artifact?: unknown })?.artifact
  const rawPath = (artifact as { path?: unknown } | undefined)?.path
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new Error('Skill result is missing artifact.path')
  }
  const candidate = isAbsolute(rawPath) ? rawPath : resolve(workspaceDir, rawPath)
  if (!isPathInsideWorkspace(workspaceDir, candidate)) {
    throw new Error('Skill artifact path escapes the workspace')
  }
  return candidate
}

async function toCanonical(
  completion: ActionCompletionForArtifact,
  workspaceDir: string,
): Promise<CareerCompetencyModelArtifact> {
  let result: unknown = completion.result
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result)
    } catch {
      // Preserve the original value so the schema reports the canonical error.
    }
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Skill result is not an object')
  }

  const modelPath = resolveModelPath(result, workspaceDir)
  const source = await readFile(modelPath, 'utf8')
  const model = careerCompetencyModelSchema.parse(JSON.parse(source))

  return {
    schema_version: '1.0',
    artifact_type: 'CareerCompetencyModel',
    created_at: completion.completed_at,
    lineage: {
      skill_call_id: completion.skill_call_id,
      skill_name: completion.skill_name,
      agent_id: completion.agent_id,
    },
    model,
  }
}

const CATEGORY_LABELS: Record<string, string> = {
  knowledge: '知识',
  skill: '技能',
  tool: '工具',
  job_task: '岗位任务',
  experience: '经验',
  credential: '证书资质',
}

const SOURCE_TYPE_LABELS: Record<string, string> = {
  job_posting: '职位发布',
  employer: '雇主',
  government: '政府/官方',
  professional_body: '专业机构',
  official_documentation: '官方文档',
  curriculum: '课程',
  textbook: '教材',
  paper: '论文',
  survey: '调研',
  other: '其他',
}

const IMPORTANCE_LABELS: Record<string, string> = {
  core: '核心',
  important: '重要',
  supporting: '支撑',
}

const DEPTH_LABELS: Record<string, string> = {
  awareness: '认知',
  working: '实操',
  independent: '独立',
  advanced: '进阶',
}

function renderSourceRef(refs: string[], sourcesById: Map<string, CareerCompetencyModel['sources'][number]>) {
  return refs
    .filter(ref => sourcesById.has(ref))
    .map(ref => `<span class="source-ref">${escapeHtml(ref)}</span>`)
    .join('')
}

function renderCompetency(
  competency: CareerCompetencyModel['competency_domains'][number]['competencies'][number],
  requirementsById: Map<string, CareerCompetencyModel['requirements'][number]>,
  tasksById: Map<string, CareerCompetencyModel['job_tasks'][number]>,
  sourcesById: Map<string, CareerCompetencyModel['sources'][number]>,
) {
  const requirementRefs = (competency.requirement_refs ?? []).map(ref => {
    const statement = requirementsById.get(ref)?.statement
    return statement ? `${escapeHtml(statement)} <span class="source-ref">${escapeHtml(ref)}</span>` : null
  }).filter((item): item is string => Boolean(item))
  const taskRefs = (competency.related_job_task_refs ?? []).map(ref => {
    const task = tasksById.get(ref)
    return task ? `${escapeHtml(task.name)} <span class="source-ref">${escapeHtml(ref)}</span>` : null
  }).filter((item): item is string => Boolean(item))

  return `
    <article class="competency">
      <div class="competency-head">
        <h4>${escapeHtml(competency.name)}</h4>
        <div class="badges">
          <span class="badge importance importance-${escapeHtml(competency.importance)}">${escapeHtml(IMPORTANCE_LABELS[competency.importance] ?? competency.importance)}</span>
          <span class="badge depth depth-${escapeHtml(competency.expected_depth)}">${escapeHtml(DEPTH_LABELS[competency.expected_depth] ?? competency.expected_depth)}</span>
        </div>
      </div>
      ${competency.definition ? `<p>${escapeHtml(competency.definition)}</p>` : ''}
      ${requirementRefs.length ? `<p class="refs-label">关联要求</p>${list(requirementRefs, '')}` : ''}
      ${taskRefs.length ? `<p class="refs-label">关联岗位任务</p>${list(taskRefs, '')}` : ''}
    </article>`
}

function renderDomain(
  domain: CareerCompetencyModel['competency_domains'][number],
  requirementsById: Map<string, CareerCompetencyModel['requirements'][number]>,
  tasksById: Map<string, CareerCompetencyModel['job_tasks'][number]>,
  sourcesById: Map<string, CareerCompetencyModel['sources'][number]>,
) {
  return `
    <section>
      <div class="domain-head">
        <h3>${escapeHtml(domain.name)}</h3>
        <span class="source-ref">${escapeHtml(domain.id)}</span>
      </div>
      ${domain.definition ? `<p class="muted">${escapeHtml(domain.definition)}</p>` : ''}
      ${domain.competencies.map(competency => renderCompetency(competency, requirementsById, tasksById, sourcesById)).join('')}
    </section>`
}

function renderCareerCompetencyModelHtml(
  artifact: CareerCompetencyModelArtifact,
): string {
  const model = artifact.model
  const target = model.target
  const requirements = model.requirements ?? []
  const tasks = model.job_tasks ?? []
  const domains = model.competency_domains ?? []
  const sources = model.sources ?? []
  const relationships = model.relationships ?? []
  const limitations = model.limitations ?? []

  const requirementsById = new Map(requirements.map(item => [item.id, item]))
  const tasksById = new Map(tasks.map(item => [item.id, item]))
  const sourcesById = new Map(sources.map(item => [item.id, item]))

  const competencyCount = domains.reduce((sum, domain) => sum + domain.competencies.length, 0)
  const targetBadges = [
    target.industry ? `行业：${target.industry}` : null,
    target.region ? `地区：${target.region}` : null,
    target.seniority ? `资历：${target.seniority}` : null,
    target.specialization ? `方向：${target.specialization}` : null,
  ].filter((item): item is string => Boolean(item))

  const scopeNotes = (target.scope_notes ?? []).map(item => escapeHtml(item))
  const sourceMix = (model.methodology.source_mix ?? []).map(item =>
    `<span class="chip">${escapeHtml(item)}</span>`,
  )

  const requirementGroups = new Map<string, CareerCompetencyModel['requirements'][number][]>()
  for (const requirement of requirements) {
    const group = requirementGroups.get(requirement.category) ?? []
    group.push(requirement)
    requirementGroups.set(requirement.category, group)
  }

  const requirementSections = Array.from(requirementGroups.entries())
    .map(([category, items]) => {
      const rows = items.map(item => {
        const refs = renderSourceRef(item.source_refs ?? [], sourcesById)
        return `<li>${escapeHtml(item.statement)}${refs}</li>`
      })
      return `
      <section>
        <h3>${escapeHtml(CATEGORY_LABELS[category] ?? category)}</h3>
        <ul>${rows.join('')}</ul>
      </section>`
    })
    .join('')

  const taskRows = tasks.map(task => {
    const refs = renderSourceRef(task.source_refs ?? [], sourcesById)
    return `<li><strong>${escapeHtml(task.name)}</strong>${refs}${task.description ? `<br><span class="muted">${escapeHtml(task.description)}</span>` : ''}</li>`
  })

  const relationshipRows = relationships.map(relationship => {
    const from = competencyNameById(domains, relationship.from_competency_ref)
    const to = competencyNameById(domains, relationship.to_competency_ref)
    const type = relationship.type === 'prerequisite' ? '前置' : '组成'
    return `<li><span class="source-ref">${escapeHtml(relationship.from_competency_ref)}</span> ${escapeHtml(from)} <strong>→ ${type} →</strong> <span class="source-ref">${escapeHtml(relationship.to_competency_ref)}</span> ${escapeHtml(to)}${relationship.rationale ? `<br><span class="muted">${escapeHtml(relationship.rationale)}</span>` : ''}</li>`
  })

  const sourceRows = sources.map(source => {
    const date = source.published_or_updated_at
      ? `发布/更新：${source.published_or_updated_at}`
      : ''
    const accessed = source.accessed_at ? `访问：${source.accessed_at}` : ''
    const meta = [date, accessed].filter(Boolean).join(' · ')
    return `<li>
      <div class="source-head">
        <strong>${escapeHtml(source.title)}</strong>
        <span class="badge">${escapeHtml(SOURCE_TYPE_LABELS[source.source_type] ?? source.source_type)}</span>
      </div>
      ${source.publisher ? `<p class="muted">${escapeHtml(source.publisher)}</p>` : ''}
      ${source.url ? `<p class="source-url">${escapeHtml(source.url)}</p>` : ''}
      ${source.relevance ? `<p class="muted">${escapeHtml(source.relevance)}</p>` : ''}
      ${meta ? `<p class="source-meta">${escapeHtml(meta)}</p>` : ''}
    </li>`
  })

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(target.role)} · 岗位能力模型</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17211f; background: #f4f7f5; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 28px; line-height: 1.6; }
    main { max-width: 980px; margin: 0 auto; }
    header, section { background: #fff; border: 1px solid #dce6e1; border-radius: 18px; padding: 22px; margin-bottom: 16px; box-shadow: 0 8px 28px rgba(26, 58, 48, .06); }
    .eyebrow { margin: 0 0 6px; color: #397363; font-size: 12px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    h1, h2, h3, h4, p { margin-top: 0; }
    h1 { margin-bottom: 8px; font-size: clamp(25px, 4vw, 38px); line-height: 1.2; }
    h2 { margin-bottom: 14px; font-size: 20px; }
    h3 { margin-bottom: 12px; font-size: 17px; }
    h4 { margin-bottom: 0; font-size: 15px; }
    .scope, .muted, .empty { color: #64736f; }
    .badges { display: flex; flex-wrap: wrap; gap: 7px; }
    .badge { display: inline-flex; padding: 4px 9px; border-radius: 999px; background: #edf1ef; font-size: 12px; font-weight: 750; white-space: nowrap; }
    .importance-core { color: #fff; background: #245f50; }
    .importance-important { color: #315f78; background: #e6f3fa; }
    .importance-supporting { color: #52615d; background: #edf1ef; }
    .depth-advanced { color: #fff; background: #397363; }
    .depth-independent { color: #245f50; background: #e3f4ec; }
    .depth-working { color: #315f78; background: #e6f3fa; }
    .depth-awareness { color: #8a5019; background: #fff0dd; }
    .chip { display: inline-flex; padding: 4px 9px; border-radius: 999px; background: #e9f4ef; color: #245f50; font-size: 12px; font-weight: 750; }
    .domain-head { display: flex; gap: 12px; justify-content: space-between; align-items: baseline; }
    .competency { padding: 15px 0; border-top: 1px solid #e6ece9; }
    .competency:first-of-type { border-top: 0; padding-top: 0; }
    .competency:last-of-type { padding-bottom: 0; }
    .competency-head { display: flex; gap: 12px; justify-content: space-between; align-items: flex-start; }
    .refs-label { margin: 10px 0 0; color: #397363; font-size: 12px; font-weight: 800; letter-spacing: .06em; }
    .source-ref { display: inline-flex; padding: 1px 6px; border-radius: 6px; background: #edf1ef; color: #52615d; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; white-space: nowrap; }
    ul { margin: 8px 0 0; padding-left: 21px; }
    li + li { margin-top: 6px; }
    .source-head { display: flex; gap: 12px; justify-content: space-between; align-items: flex-start; }
    .source-url { color: #397363; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }
    .source-meta { margin: 0; color: #8a9591; font-size: 12px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .grid section { margin: 0; }
    @media (max-width: 700px) { body { padding: 14px; } .grid { grid-template-columns: 1fr; } .competency-head, .domain-head, .source-head { flex-direction: column; } }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Career Competency Model</p>
      <h1>${escapeHtml(target.role)}</h1>
      ${targetBadges.length ? `<div class="badges">${targetBadges.map(item => `<span class="badge">${escapeHtml(item)}</span>`).join('')}</div>` : ''}
      ${scopeNotes.length ? `<p class="scope">${scopeNotes.map(item => escapeHtml(item)).join('；')}</p>` : ''}
      <p class="muted">${escapeHtml(domains.length)} 个能力域 · ${escapeHtml(competencyCount)} 项能力 · ${escapeHtml(requirements.length)} 条要求 · ${escapeHtml(tasks.length)} 项岗位任务 · ${escapeHtml(sources.length)} 个来源</p>
    </header>
    <section>
      <h2>研究方法</h2>
      ${model.methodology.as_of ? `<p class="muted">数据截至：${escapeHtml(model.methodology.as_of)}</p>` : ''}
      ${model.methodology.research_summary ? `<p>${escapeHtml(model.methodology.research_summary)}</p>` : ''}
      ${sourceMix.length ? `<div class="badges">${sourceMix.join('')}</div>` : ''}
    </section>
    <h2>能力域</h2>
    ${domains.map(domain => renderDomain(domain, requirementsById, tasksById, sourcesById)).join('')}
    <h2>岗位任务</h2>
    ${tasks.length ? `<section>${list(taskRows, '没有列出岗位任务。')}</section>` : ''}
    <h2>要求清单</h2>
    ${requirementSections || '<p class="empty">没有列出要求条目。</p>'}
    <div class="grid">
      <section><h2>能力关系</h2>${list(relationshipRows, '没有记录能力关系。')}</section>
      <section><h2>局限</h2>${list(limitations.map(item => escapeHtml(item)), '没有额外限制。')}</section>
    </div>
    <h2>信息来源</h2>
    ${sources.length ? `<section>${list(sourceRows, '')}</section>` : ''}
  </main>
</body>
</html>`
}

function competencyNameById(
  domains: CareerCompetencyModel['competency_domains'],
  ref: string,
): string {
  for (const domain of domains) {
    for (const competency of domain.competencies) {
      if (competency.id === ref) return competency.name
    }
  }
  return ref
}

export function createCareerCompetencyModelArtifactAdapter(
  workspaceDir: string,
): ActionArtifactAdapter<CareerCompetencyModelArtifact & JsonValue> {
  return {
    artifactType: 'career-competency-model',
    artifactSlug: 'career-competency-model',
    schemaVersion: '1.0',
    toCanonical(completion) {
      return toCanonical(completion, workspaceDir)
    },
    render(artifact) {
      const model = artifact.model
      const researchSummary = model.methodology.research_summary
      return {
        title: `${model.target.role} · 岗位能力模型`,
        summary:
          researchSummary?.trim()
          ?? `${model.competency_domains?.length ?? 0} 个能力域的岗位能力模型`,
        renderMode: 'html',
        html: renderCareerCompetencyModelHtml(artifact),
      }
    },
  }
}
