import { describe, expect, test } from 'bun:test'
import {
  createQueryEngineForSession,
  createServerAppState,
} from '../src/server/queryEngineFactory.js'

describe('server QueryEngine factory', () => {
  test('starts from the canonical AppState required by child-agent cleanup', () => {
    const { getAppState, setAppState } = createServerAppState()

    expect(getAppState().todos).toEqual({})
    setAppState(prev => ({
      ...prev,
      todos: { ...prev.todos, childAgent: [] },
    }))
    setAppState(prev => {
      if (!('childAgent' in prev.todos)) return prev
      const { childAgent: _removed, ...todos } = prev.todos
      return { ...prev, todos }
    })

    expect(getAppState().todos).toEqual({})
    expect(getAppState().agentDefinitions).toEqual({
      activeAgents: [],
      allAgents: [],
    })
  })

  test('uses a cloneable FileStateCache for context forks', () => {
    const engine = createQueryEngineForSession(
      {
        config: {
          cwd: process.cwd(),
          model: 'test-model',
        },
        mcpClients: [],
        abortController: new AbortController(),
      } as never,
      { exactTools: [] },
    )

    const cache = engine.getReadFileState()
    expect(typeof cache.dump).toBe('function')
    expect(cache.dump()).toEqual([])
  })
})
