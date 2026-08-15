import { describe, expect, test } from 'bun:test'
import { getBundledSkills } from '../src/skills/bundledSkills.js'
import { registerCareerAgentSkills } from '../src/skills/bundled/careerAgent.js'
import {
  SkillService,
  USER_DEFINED_SKILLS_ENABLED,
} from '../src/Network/modules/skill/skill.service.js'
import { SkillRegistry } from '../src/Network/modules/skill/skill.registry.js'
import { registerBuiltinSkills } from '../src/Network/modules/skill/built-in-skills.js'
import { getSkillToolCommands } from '../src/commands.js'
import { SkillTool } from '../src/tools/SkillTool/SkillTool.js'

const CAREER_AGENT_SKILL_NAMES = ['baseline-assessment', 'code-analysis'].sort()

const PACKAGED_GLOBAL_SKILL_NAMES = ['baseline-assessment']

registerCareerAgentSkills()

describe('CareerAgent skills on the native CC skill chain', () => {
  test('registers the same global skills for every user', () => {
    const names = getBundledSkills()
      .map(skill => skill.name)
      .filter(name => CAREER_AGENT_SKILL_NAMES.includes(name))
      .sort()

    expect(names).toEqual(CAREER_AGENT_SKILL_NAMES)
    expect(USER_DEFINED_SKILLS_ENABLED).toBe(false)
  })

  test('rejects user-defined skill creation without writing a skill file', async () => {
    const service = new SkillService(new SkillRegistry())
    let status: number | undefined

    try {
      await service.createCustomSkill(
        42,
        'private-skill',
        'private skill',
        'private instructions',
      )
    } catch (error) {
      status = (error as { getStatus?: () => number }).getStatus?.()
    }

    expect(status).toBe(501)
  })

  test('exposes packaged skills from the root skills directory through the backend catalog', async () => {
    const service = new SkillService(new SkillRegistry())
    const skills = await service.listSkills(42)
    const names = skills.map(skill => skill.name)

    for (const name of PACKAGED_GLOBAL_SKILL_NAMES) {
      expect(names).toContain(name)
    }

    expect(names).not.toContain('image-generation')
    expect(names).not.toContain('video-generation')
    expect(names).not.toContain('help')
    expect(skills.find(skill => skill.name === 'baseline-assessment')?.category).toBe('analysis')
  })

  test('keeps code-defined built-in skills in the Network registry', () => {
    const registry = new SkillRegistry()
    registerBuiltinSkills(entry => registry.register(entry))

    expect(registry.getAll().map(skill => skill.name)).toEqual(['code-analysis'])
  })

  test('loads the hyphenated baseline-assessment prompt with its evidence boundary', async () => {
    const skill = getBundledSkills().find(
      item => item.name === 'baseline-assessment',
    )

    expect(skill).toBeDefined()
    expect(skill?.userInvocable).toBe(true)
    if (!skill || skill.type !== 'prompt') {
      throw new Error('baseline-assessment was not registered as a prompt skill')
    }

    const blocks = await skill.getPromptForCommand(
      'Assess my backend baseline from existing evidence.',
      {} as never,
    )
    const text = blocks
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')

    expect(skill.name).toBe('baseline-assessment')
    expect(skill.modelEntry).toBe('action-tool')
    expect(text).toContain('Base directory for this skill:')
    expect(text).toContain('Freeze the evidence boundary at invocation time.')
    expect(text).toContain('Use `ReturnSkillResult` as the only tool call')
    expect(text).toContain(
      'Assess my backend baseline from existing evidence.',
    )
  })

  test('keeps baseline-assessment out of the generic model Skill entry', async () => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'catalog-test-key'
    try {
      const modelSkills = await getSkillToolCommands(process.cwd())
      expect(
        modelSkills.some(skill => skill.name === 'baseline-assessment'),
      ).toBe(false)

      const validation = await SkillTool.validateInput(
        { skill: 'baseline-assessment' },
        {
          getAppState() {
            return { mcp: { commands: [] } }
          },
        } as never,
      )
      expect(validation).toMatchObject({
        result: false,
        errorCode: 7,
      })
    } finally {
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previousApiKey
    }
  })

})
