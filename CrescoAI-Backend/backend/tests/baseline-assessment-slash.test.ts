import { describe, expect, test } from 'bun:test'
import type { PromptCommand, CommandBase } from '../src/types/command.js'
import { executeBaselineAssessmentSlashCommand } from '../src/utils/processUserInput/processSlashCommand.js'

describe('/baseline-assessment action entry', () => {
  test('injects an already-executed result and returns control to the main Agent', async () => {
    const command = {
      type: 'prompt',
      name: 'baseline-assessment',
      description: 'Assess existing evidence.',
      progressMessage: 'running',
      contentLength: 1,
      source: 'bundled',
      loadedFrom: 'bundled',
      modelEntry: 'action-tool',
      async getPromptForCommand() {
        return [{ type: 'text' as const, text: 'prompt' }]
      },
    } as CommandBase & PromptCommand
    const result = await executeBaselineAssessmentSlashCommand(
      command,
      ' backend engineering ',
      {} as never,
      [],
      async () => ({ behavior: 'allow', updatedInput: {} }),
      async ({ assessmentTarget }) => ({
        skill_call_id: 'call-1',
        skill_name: 'baseline-assessment',
        agent_id: 'agent-1',
        execution_status: 'completed',
        outcome: 'insufficient_input',
        summary: `No evidence for ${assessmentTarget?.trim()}.`,
        completed_at: '2026-08-14T00:00:00.000Z',
        duration_ms: 10,
      }),
    )

    expect(result.shouldQuery).toBe(true)
    expect(result.messages).toHaveLength(2)
    expect(result.messages[1]).toMatchObject({ type: 'user', isMeta: true })
    const metaContent = result.messages[1]?.type === 'user'
      ? result.messages[1].message.content
      : ''
    expect(metaContent).toContain('already_executed="true"')
    expect(metaContent).toContain('Do not call BaselineAssessment again')
    expect(metaContent).toContain('"outcome":"insufficient_input"')
  })
})
