import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod/v4'
import {
  isPathInsideWorkspace,
  type ActionArtifactAdapter,
  type ActionCompletionForArtifact,
} from '../../artifacts/actionArtifactPublisher.js'
import type { JsonValue } from '../../skills/skillLifecycleTypes.js'

const depthLevelSchema = z.enum([
  'awareness',
  'working',
  'independent',
  'advanced',
])
const abilityLevelSchema = z.enum([
  'awareness',
  'foundational',
  'applied',
  'independent',
  'advanced',
])
const importanceSchema = z.enum(['core', 'important', 'supporting'])
const goalLevelSchema = z.enum(['working', 'independent', 'advanced']).nullable()
const confidenceSchema = z.enum(['low', 'medium', 'high'])

const nullableString = z.string().optional().nullable()

const learningPlanSchema = z.object({
  schema_version: z.string(),
  artifact_type: z.string(),
  created_at: z.string().optional(),
  version: z.number().int().positive(),
  updated_at: z.string().datetime({ offset: true }),
  planning_constraints: z.object({
    available_time_per_week: z.string().trim().min(1),
    deadline: z.string().trim().min(1).nullable(),
    resource_constraints: z.string().trim().min(1).optional(),
    explicit_goals: z.string().trim().min(1).optional(),
    notes: z.string().trim().min(1).optional(),
  }),
  lineage: z.object({
    model_ref: z.string().nullable(),
    model_as_of: z.string().nullable(),
    baseline_ref: z.string().nullable(),
    baseline_completed_at: z.string().nullable(),
    validation: z.object({
      target_correspondence: z.string(),
      freshness_judgment: z.string(),
      notes: z.array(z.string()).optional(),
    }),
  }),
  target: z.object({
    role: z.string(),
    industry: nullableString,
    region: nullableString,
    seniority: nullableString,
    specialization: nullableString,
  }),
  goal_level: goalLevelSchema,
  baseline_summary: z.object({
    overall_level: abilityLevelSchema,
    overall_confidence: confidenceSchema,
    coverage_note: z.string(),
  }),
  prioritized_gaps: z.array(
    z.object({
      competency_ref: z.string(),
      competency_name: z.string(),
      domain_ref: z.string(),
      importance: importanceSchema,
      expected_depth: depthLevelSchema,
      target_depth: depthLevelSchema,
      current_level: abilityLevelSchema.nullable(),
      gap: z.enum(['missing', 'shallow']),
      delta: z.number().int().min(0).max(4),
      priority: z.number().int().min(1),
      prerequisites: z.array(z.string()).optional(),
      rationale: z.string(),
    }),
  ),
  stages: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      goal: z.string(),
      competency_refs: z.array(z.string()),
      expected_level_after: depthLevelSchema,
      estimated_duration: z.object({
        value: z.string(),
        basis: z.enum(['from_user_constraints', 'estimate']),
      }),
      depends_on: z.array(z.string()).optional(),
      rationale: z.string(),
    }),
  ),
  assumptions: z.array(z.string()).optional(),
  limitations: z.array(z.string()).optional(),
})

type LearningPlan = z.infer<typeof learningPlanSchema>

export type LearningPlanArtifact = {
  schema_version: '1.0'
  artifact_type: 'LearningPlan'
  created_at: string
  lineage: {
    skill_call_id: string
    skill_name: string
    agent_id: string
  }
  plan: LearningPlan
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

const ABILITY_LABELS: Record<string, string> = {
  awareness: '认知',
  foundational: '基础',
  applied: '应用',
  independent: '独立',
  advanced: '进阶',
}

const GAP_LABELS: Record<string, string> = {
  missing: '缺失（需从头建立）',
  shallow: '深度不足',
}

const CONFIDENCE_LABELS: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
}

function resolvePlanPath(result: unknown, workspaceDir: string): string {
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
): Promise<LearningPlanArtifact> {
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

  const planPath = resolvePlanPath(result, workspaceDir)
  const source = await readFile(planPath, 'utf8')
  const plan = learningPlanSchema.parse(JSON.parse(source))

  return {
    schema_version: '1.0',
    artifact_type: 'LearningPlan',
    created_at: completion.completed_at,
    lineage: {
      skill_call_id: completion.skill_call_id,
      skill_name: completion.skill_name,
      agent_id: completion.agent_id,
    },
    plan,
  }
}

function renderScope(plan: LearningPlan): string {
  const parts = [
    plan.target.industry,
    plan.target.seniority,
    plan.target.region,
    plan.target.specialization,
  ].filter((part): part is string => Boolean(part))
  return parts.map(part => escapeHtml(part)).join(' · ')
}

function renderGap(
  gap: LearningPlan['prioritized_gaps'][number],
  competencyNamesById: Map<string, string>,
): string {
  const prerequisites = (gap.prerequisites ?? [])
    .map(ref => competencyNamesById.get(ref))
    .filter((name): name is string => Boolean(name))
  const prerequisiteText = prerequisites.length
    ? `<p class="muted">前置：${prerequisites.map(name => escapeHtml(name)).join(' → ')}</p>`
    : ''
  const currentLevel = gap.current_level
    ? ABILITY_LABELS[gap.current_level] ?? gap.current_level
    : '无证据'
  return `
    <article class="gap">
      <div class="gap-head">
        <h3>${escapeHtml(gap.competency_name)}</h3>
        <div class="badges">
          <span class="badge priority">P${gap.priority}</span>
          <span class="badge importance importance-${escapeHtml(gap.importance)}">${escapeHtml(IMPORTANCE_LABELS[gap.importance] ?? gap.importance)}</span>
          <span class="badge gap gap-${escapeHtml(gap.gap)}">${escapeHtml(GAP_LABELS[gap.gap] ?? gap.gap)}</span>
        </div>
      </div>
      <p class="muted">当前 ${escapeHtml(currentLevel)} → 目标 ${escapeHtml(DEPTH_LABELS[gap.target_depth] ?? gap.target_depth)}（市场期望 ${escapeHtml(DEPTH_LABELS[gap.expected_depth] ?? gap.expected_depth)}，差距 ${gap.delta} 档）</p>
      <p>${escapeHtml(gap.rationale)}</p>
      ${prerequisiteText}
    </article>`
}

function renderStage(
  stage: LearningPlan['stages'][number],
  competencyNamesById: Map<string, string>,
): string {
  const competencies = stage.competency_refs
    .map(ref => competencyNamesById.get(ref))
    .filter((name): name is string => Boolean(name))
  const basis =
    stage.estimated_duration.basis === 'from_user_constraints'
      ? '按用户约束'
      : '估算'
  const dependsOn = (stage.depends_on ?? []).length
    ? ` · 依赖：${stage.depends_on.map(id => escapeHtml(id)).join('、')}`
    : ''
  return `
    <article class="stage">
      <div class="stage-head">
        <h3>${escapeHtml(stage.name)}</h3>
        <div class="badges">
          <span class="badge">${escapeHtml(stage.estimated_duration.value)}</span>
          <span class="badge">${escapeHtml(basis)}</span>
          <span class="badge level">阶段后：${escapeHtml(DEPTH_LABELS[stage.expected_level_after] ?? stage.expected_level_after)}</span>
        </div>
      </div>
      <p><strong>目标：</strong>${escapeHtml(stage.goal)}</p>
      ${list(competencies.map(name => escapeHtml(name)), '没有分配能力。')}
      <p class="muted">${escapeHtml(stage.rationale)}${dependsOn}</p>
    </article>`
}

function renderLearningPlanHtml(artifact: LearningPlanArtifact): string {
  const plan = artifact.plan
  const competencyNamesById = new Map(
    plan.prioritized_gaps.map(gap => [gap.competency_ref, gap.competency_name]),
  )
  const validationNotes = (plan.lineage.validation.notes ?? [])
    .map(note => escapeHtml(note))
  const assumptions = (plan.assumptions ?? []).map(item => escapeHtml(item))
  const limitations = (plan.limitations ?? []).map(item => escapeHtml(item))
  const goalLine = plan.goal_level
    ? `目标水平：${escapeHtml(DEPTH_LABELS[plan.goal_level] ?? plan.goal_level)}`
    : '目标水平：对齐市场预期'

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(plan.target.role)} · 学习计划</title>
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
    .scope, .muted, .empty { color: #64736f; }
    .baseline { display: grid; grid-template-columns: minmax(150px, .35fr) 1fr; gap: 18px; align-items: stretch; }
    .baseline-level { display: flex; flex-direction: column; justify-content: center; border-radius: 14px; padding: 18px; background: #e9f4ef; }
    .baseline-level strong { font-size: 25px; color: #245f50; }
    .gap, .stage { padding: 17px 0; border-top: 1px solid #e6ece9; }
    .gap:first-of-type, .stage:first-of-type { border-top: 0; padding-top: 0; }
    .gap:last-of-type, .stage:last-of-type { padding-bottom: 0; }
    .gap-head, .stage-head { display: flex; gap: 12px; justify-content: space-between; align-items: flex-start; }
    .badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 7px; }
    .badge { display: inline-flex; padding: 4px 9px; border-radius: 999px; background: #edf1ef; font-size: 12px; font-weight: 750; white-space: nowrap; }
    .badge.priority, .badge.level { color: #fff; background: #397363; }
    .gap-missing { color: #8a5019; background: #fff0dd; }
    .gap-shallow { color: #315f78; background: #e6f3fa; }
    .importance-core { color: #7c2d12; background: #fde9de; }
    .importance-important { color: #315f78; background: #e6f3fa; }
    ul { margin: 8px 0 0; padding-left: 21px; }
    li + li { margin-top: 6px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .grid section { margin: 0; }
    @media (max-width: 700px) { body { padding: 14px; } .baseline, .grid { grid-template-columns: 1fr; } .gap-head, .stage-head { flex-direction: column; } .badges { justify-content: flex-start; } }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Learning Plan</p>
      <h1>${escapeHtml(plan.target.role)}</h1>
      <p class="scope">${renderScope(plan)}</p>
      <p class="muted">${goalLine}</p>
    </header>
    <section>
      <h2>当前基线</h2>
      <div class="baseline">
        <div class="baseline-level"><span>整体水平</span><strong>${escapeHtml(ABILITY_LABELS[plan.baseline_summary.overall_level] ?? plan.baseline_summary.overall_level)}</strong><span>置信度 ${escapeHtml(CONFIDENCE_LABELS[plan.baseline_summary.overall_confidence] ?? plan.baseline_summary.overall_confidence)}</span></div>
        <p>${escapeHtml(plan.baseline_summary.coverage_note)}</p>
      </div>
      <p class="muted">目标对应性：${escapeHtml(plan.lineage.validation.target_correspondence)}<br>新鲜度判断：${escapeHtml(plan.lineage.validation.freshness_judgment)}${validationNotes.map(note => `<br>${note}`).join('')}</p>
    </section>
    <section>
      <h2>优先差距</h2>
      ${plan.prioritized_gaps.map(gap => renderGap(gap, competencyNamesById)).join('')}
    </section>
    <section>
      <h2>学习阶段</h2>
      ${plan.stages.map(stage => renderStage(stage, competencyNamesById)).join('')}
    </section>
    <div class="grid">
      <section><h2>假设</h2>${list(assumptions, '没有额外假设。')}</section>
      <section><h2>限制</h2>${list(limitations, '没有额外限制。')}</section>
    </div>
  </main>
</body>
</html>`
}

export function createLearningPlanArtifactAdapter(
  workspaceDir: string,
): ActionArtifactAdapter<LearningPlanArtifact & JsonValue> {
  return {
    artifactType: 'learning-plan',
    artifactSlug: 'learning-plan',
    schemaVersion: '1.0',
    toCanonical(completion) {
      return toCanonical(completion, workspaceDir)
    },
    render(artifact) {
      return {
        title: `${artifact.plan.target.role} · 学习计划`,
        summary:
          `${artifact.plan.prioritized_gaps.length} 项优先差距 · ${artifact.plan.stages.length} 个学习阶段`,
        renderMode: 'html',
        html: renderLearningPlanHtml(artifact),
      }
    },
  }
}
