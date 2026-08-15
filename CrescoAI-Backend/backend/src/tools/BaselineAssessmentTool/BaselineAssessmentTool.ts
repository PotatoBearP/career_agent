import { z } from 'zod/v4'
import {
  BASELINE_ASSESSMENT_SKILL_NAME,
  BASELINE_ASSESSMENT_TOOL_NAME,
} from '../../skills/baselineAssessmentAction.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { createSkillActionTool } from '../SkillActionTool/createSkillActionTool.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    assessment_target: z.string().trim().min(1).optional(),
  }),
)

export const BaselineAssessmentTool = createSkillActionTool({
  skillName: BASELINE_ASSESSMENT_SKILL_NAME,
  toolName: BASELINE_ASSESSMENT_TOOL_NAME,
  inputSchema,
  userFacingName: 'Baseline assessment',
  searchHint: 'assess an existing evidence baseline for a role, domain, or task',
  alwaysLoad: true,
  readOnly: true,
  progressMessage: 'Assessing baseline',
  // The Skill freezes evidence at invocation time and may only close itself.
  childToolNames: [],
  toActionInput({ assessment_target }) {
    return assessment_target ? { assessment_target } : undefined
  },
  toClassifierInput({ assessment_target }) {
    return assessment_target ?? ''
  },
  renderInvocation({ assessment_target }) {
    return assessment_target
      ? `Assess baseline for ${assessment_target}`
      : 'Assess baseline from existing evidence'
  },
})
