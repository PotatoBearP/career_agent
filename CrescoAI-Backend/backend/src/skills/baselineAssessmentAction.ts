import type { ToolUseContext } from '../Tool.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { CommandBase, PromptCommand } from '../types/command.js'
import type { CompletedSkillAction } from './forkedSkillExecutor.js'
import { executeSkillAction, getSkillActionCommand } from './skillAction.js'

export const BASELINE_ASSESSMENT_SKILL_NAME = 'baseline-assessment'
export const BASELINE_ASSESSMENT_TOOL_NAME = 'BaselineAssessment'

export async function getBaselineAssessmentCommand(): Promise<
  CommandBase & PromptCommand
> {
  return getSkillActionCommand(BASELINE_ASSESSMENT_SKILL_NAME)
}

export async function executeBaselineAssessmentAction(input: {
  assessmentTarget?: string
  context: ToolUseContext
  canUseTool: CanUseToolFn
}): Promise<CompletedSkillAction> {
  const assessmentTarget = input.assessmentTarget?.trim()
  return executeSkillAction({
    skillName: BASELINE_ASSESSMENT_SKILL_NAME,
    actionInput: assessmentTarget
      ? { assessment_target: assessmentTarget }
      : undefined,
    context: input.context,
    canUseTool: input.canUseTool,
  })
}
