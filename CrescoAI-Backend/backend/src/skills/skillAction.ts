import { getProjectRoot } from '../bootstrap/state.js'
import { findCommand, getCommands } from '../commands.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../Tool.js'
import type { CommandBase, PromptCommand } from '../types/command.js'
import {
  executeForkedPromptSkill,
  type CompletedSkillAction,
} from './forkedSkillExecutor.js'
import type { JsonValue } from './skillLifecycleTypes.js'

export async function getSkillActionCommand(
  skillName: string,
): Promise<CommandBase & PromptCommand> {
  const commands = await getCommands(getProjectRoot())
  const command = findCommand(skillName, commands)
  if (!command || command.type !== 'prompt') {
    throw new Error(`${skillName} Skill is not registered`)
  }
  if (command.modelEntry !== 'action-tool') {
    throw new Error(`${skillName} Skill is not configured for action-tool entry`)
  }
  return command
}

export async function executeSkillAction(input: {
  skillName: string
  actionInput?: JsonValue
  context: ToolUseContext
  canUseTool: CanUseToolFn
}): Promise<CompletedSkillAction> {
  const command = await getSkillActionCommand(input.skillName)
  const execution = await executeForkedPromptSkill({
    command,
    commandName: input.skillName,
    actionInput: input.actionInput,
    contextMode: 'fork',
    requireCompletion: true,
    context: input.context,
    canUseTool: input.canUseTool,
  })
  if (!execution.completion) {
    throw new Error(`${input.skillName} did not produce a lifecycle result`)
  }
  return execution.completion
}
