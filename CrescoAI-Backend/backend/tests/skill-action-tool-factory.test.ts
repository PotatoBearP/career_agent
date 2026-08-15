import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  GENERATED_FILE_MARKER,
  buildSkillActionToolPlan,
  renderSkillActionTool,
  writeSkillActionToolPlan,
} from '../scripts/generate-skill-action-tools.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })),
  )
})

async function createFixture(): Promise<{
  root: string
  skillsDir: string
  toolsDir: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'skill-action-tool-factory-'))
  temporaryRoots.push(root)
  const skillsDir = join(root, 'skills')
  const toolsDir = join(root, 'src/tools')
  await mkdir(skillsDir, { recursive: true })
  await mkdir(toolsDir, { recursive: true })
  return { root, skillsDir, toolsDir }
}

async function writeSkill(input: {
  skillsDir: string
  name: string
  modelEntry?: 'action-tool' | 'skill-catalog'
  config?: Record<string, unknown>
}): Promise<void> {
  const skillDir = join(input.skillsDir, input.name)
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    join(skillDir, 'SKILL.md'),
    [
      '---',
      `name: ${input.name}`,
      `description: Execute ${input.name} from the existing context.`,
      `model-entry: ${input.modelEntry ?? 'action-tool'}`,
      '---',
      '',
      `# ${input.name}`,
      '',
      'Call ReturnSkillResult when complete.',
      '',
    ].join('\n'),
    'utf8',
  )
  if (input.config) {
    await writeFile(
      join(skillDir, 'action-tool.json'),
      `${JSON.stringify(input.config, null, 2)}\n`,
      'utf8',
    )
  }
}

describe('offline Skill Action Tool factory', () => {
  test('discovers only action-tool Skills and renders a static Tool wrapper', async () => {
    const fixture = await createFixture()
    await writeSkill({
      skillsDir: fixture.skillsDir,
      name: 'domain-map',
      config: {
        tool_name: 'DomainMap',
        user_facing_name: 'Domain map',
        input: {
          domain: {
            type: 'string',
            required: true,
            description: 'Academic domain to map.',
          },
        },
      },
    })
    await writeSkill({
      skillsDir: fixture.skillsDir,
      name: 'legacy-skill',
      modelEntry: 'skill-catalog',
    })

    const plan = await buildSkillActionToolPlan(fixture)

    expect(plan.entries).toHaveLength(1)
    expect(plan.entries[0]).toMatchObject({
      skillName: 'domain-map',
      toolName: 'DomainMap',
      exportName: 'DomainMapTool',
      disposition: 'create',
    })
    const source = renderSkillActionTool(plan.entries[0]!)
    expect(source).toContain(GENERATED_FILE_MARKER)
    expect(source).toContain("const SKILL_NAME = \"domain-map\" as const")
    expect(source).toContain('domain: z.string().trim().min(1)')
    expect(source).toContain('executeSkillAction({')
    expect(source).not.toContain('legacy-skill')
    expect(() => new Bun.Transpiler({ loader: 'ts' }).transformSync(source)).not.toThrow()
  })

  test('writes generated files only to the supplied fixture and registers them', async () => {
    const fixture = await createFixture()
    await writeSkill({ skillsDir: fixture.skillsDir, name: 'domain-map' })
    const plan = await buildSkillActionToolPlan(fixture)

    await writeSkillActionToolPlan(plan)

    const toolSource = await readFile(plan.entries[0]!.outputFile, 'utf8')
    const registrySource = await readFile(plan.registryFile, 'utf8')
    expect(toolSource).toContain('request: z.string().trim().min(1)')
    expect(registrySource).toContain(
      'DomainMapTool } from "./DomainMapTool/DomainMapTool.js"',
    )
    expect(registrySource).toContain('  DomainMapTool,')
    expect(registrySource).toContain('generatedSkillActionToolNames')
  })

  test('preserves an explicitly adopted hand-written Tool while registering it', async () => {
    const fixture = await createFixture()
    await writeSkill({
      skillsDir: fixture.skillsDir,
      name: 'baseline-assessment',
      config: {
        tool_name: 'BaselineAssessment',
        preserve_existing: true,
      },
    })
    const existingFile = join(
      fixture.toolsDir,
      'BaselineAssessmentTool/BaselineAssessmentTool.ts',
    )
    const existingSource = 'export const BaselineAssessmentTool = { name: "BaselineAssessment" }\n'
    await mkdir(join(fixture.toolsDir, 'BaselineAssessmentTool'), {
      recursive: true,
    })
    await writeFile(existingFile, existingSource, 'utf8')

    const plan = await buildSkillActionToolPlan(fixture)
    expect(plan.entries[0]?.disposition).toBe('preserve-existing')
    await writeSkillActionToolPlan(plan)

    expect(await readFile(existingFile, 'utf8')).toBe(existingSource)
    expect(await readFile(plan.registryFile, 'utf8')).toContain(
      'BaselineAssessmentTool',
    )
  })

  test('rejects generated Tool name collisions', async () => {
    const fixture = await createFixture()
    await writeSkill({
      skillsDir: fixture.skillsDir,
      name: 'first-skill',
      config: { tool_name: 'SameToolName' },
    })
    await writeSkill({
      skillsDir: fixture.skillsDir,
      name: 'second-skill',
      config: { tool_name: 'SameToolName' },
    })

    await expect(buildSkillActionToolPlan(fixture)).rejects.toThrow(
      'map to the same Tool name SameToolName',
    )
  })
})
