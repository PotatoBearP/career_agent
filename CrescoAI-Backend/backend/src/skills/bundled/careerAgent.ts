import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FrontmatterData } from '../../utils/frontmatterParser.js'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { substituteArguments } from '../../utils/argumentSubstitution.js'
import { registerBundledSkill } from '../bundledSkills.js'
import {
  getGlobalSkillsRoot,
} from '../globalSkillPaths.js'

const GLOBAL_SKILLS_DIR = getGlobalSkillsRoot()

export type GlobalDiskSkillCatalogEntry = {
  name: string
  description: string
  whenToUse: string
  argumentHint?: string
  argumentNames: string[]
  category: 'analysis' | 'generation' | 'utility' | 'search'
  modelEntry: 'action-tool' | 'skill-catalog'
  resourceRoot: string
}

let globalDiskSkillCatalogCache: GlobalDiskSkillCatalogEntry[] | undefined

function parseArgumentNames(frontmatter: FrontmatterData): string[] {
  const value = frontmatter.arguments
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string')
  }
  return typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : []
}

/**
 * Discover application-owned disk skills under the repository root `skills/`
 * directory. These are global skills, not user-authored skills, so every user
 * sees the same catalog.
 *
 * Every direct child with a valid SKILL.md is application-owned and belongs to
 * this global catalog. Runtime-only tools must not be represented here as
 * synthetic skills.
 */
export function getGlobalDiskSkillCatalog(): GlobalDiskSkillCatalogEntry[] {
  if (globalDiskSkillCatalogCache) return [...globalDiskSkillCatalogCache]

  let entries: Dirent[]
  try {
    entries = readdirSync(GLOBAL_SKILLS_DIR, { withFileTypes: true })
  } catch {
    globalDiskSkillCatalogCache = []
    return []
  }

  globalDiskSkillCatalogCache = entries
    .filter(entry => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap(entry => {
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(entry.name)) return []

      const skillDir = join(GLOBAL_SKILLS_DIR, entry.name)
      const skillFile = join(skillDir, 'SKILL.md')
      let source: string
      try {
        source = readFileSync(skillFile, 'utf8')
      } catch {
        return []
      }

      const { frontmatter } = parseFrontmatter(source, skillFile)
      const frontmatterName =
        typeof frontmatter.name === 'string' ? frontmatter.name.trim() : ''
      const description =
        typeof frontmatter.description === 'string'
          ? frontmatter.description.trim()
          : ''
      if (
        (frontmatterName && frontmatterName !== entry.name) ||
        !description
      ) {
        return []
      }

      const argumentNames = parseArgumentNames(frontmatter)
      const argumentHint =
        typeof frontmatter['argument-hint'] === 'string'
          ? frontmatter['argument-hint'].trim()
          : argumentNames.length > 0
            ? argumentNames.map(name => `[${name}]`).join(' ')
            : undefined
      const whenToUse =
        typeof frontmatter.when_to_use === 'string' &&
        frontmatter.when_to_use.trim()
          ? frontmatter.when_to_use.trim()
          : description
      const categoryValue = frontmatter.category
      const category =
        categoryValue === 'generation' ||
        categoryValue === 'utility' ||
        categoryValue === 'search'
          ? categoryValue
          : 'analysis'
      const modelEntry =
        frontmatter['model-entry'] === 'action-tool'
          ? 'action-tool'
          : 'skill-catalog'

      return [
        {
          name: entry.name,
          description,
          whenToUse,
          argumentHint,
          argumentNames,
          category,
          modelEntry,
          resourceRoot: skillDir,
        },
      ]
    })

  return [...globalDiskSkillCatalogCache]
}

async function loadDiskSkillPrompt(
  skillsRoot: string,
  skillName: string,
  args: string,
): Promise<string> {
  const skillDir = join(skillsRoot, skillName)
  const skillFile = join(skillDir, 'SKILL.md')
  const source = await readFile(skillFile, 'utf8')
  const { frontmatter, content } = parseFrontmatter(source, skillFile)
  const argumentNames = parseArgumentNames(frontmatter)
  const expanded = substituteArguments(content.trim(), args, true, argumentNames)
    .replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir)

  return `Base directory for this skill: ${skillDir}\n\n${expanded}`
}

export function registerCareerAgentSkills(): void {
  registerBundledSkill({
    name: 'code-analysis',
    description:
      'Analyze code for security vulnerabilities, correctness, performance, maintainability, and concrete improvements.',
    whenToUse:
      'Use when the user asks for code review, security analysis, performance analysis, or improvement suggestions.',
    argumentHint: '[code or review request]',
    userInvocable: true,
    async getPromptForCommand(args) {
      return [
        {
          type: 'text',
          text:
            'Analyze the code or files requested by the user. Check correctness, security, performance, maintainability, and tests. ' +
            'Use repository tools to inspect relevant context when available. Report findings by severity with precise file locations and concrete fixes.' +
            (args ? `\n\nUser request:\n${args}` : ''),
        },
      ]
    },
  })

  for (const skill of getGlobalDiskSkillCatalog()) {
    registerBundledSkill({
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      argumentHint: skill.argumentHint,
      userInvocable: true,
      resourceRoot: skill.resourceRoot,
      modelEntry: skill.modelEntry,
      async getPromptForCommand(args) {
        return [
          {
            type: 'text',
            text: await loadDiskSkillPrompt(
              GLOBAL_SKILLS_DIR,
              skill.name,
              args,
            ),
          },
        ]
      },
    })
  }
}
