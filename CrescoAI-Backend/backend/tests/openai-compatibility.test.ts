import { describe, expect, test } from 'bun:test'
import {
  createOpenAICompatibilityFetch,
  translateAnthropicRequestToOpenAI,
  translateOpenAIResponseToAnthropic,
} from '../src/services/api/openAICompatibility.js'

describe('OpenAI compatibility adapter', () => {
  test('translates Anthropic messages and tools to chat completions format', () => {
    const translated = translateAnthropicRequestToOpenAI({
      model: 'deepseek-chat',
      stream: true,
      max_tokens: 100,
      system: 'system prompt',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{
        name: 'Read',
        description: 'Read a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      }],
    })

    expect(translated.messages).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hello' },
    ])
    expect((translated.tools as any[])[0].function.name).toBe('Read')
    expect(translated.stream_options).toEqual({ include_usage: true })
  })

  test('turns Anthropic tool references into actionable OpenAI tool results', () => {
    const translated = translateAnthropicRequestToOpenAI({
      model: 'GLM-5.2',
      messages: [
        {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'tool-search-1',
            name: 'ToolSearch',
            input: { query: 'github repository information' },
          }],
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-search-1',
            content: [
              { type: 'tool_reference', tool_name: 'mcp__github__get_me' },
              { type: 'tool_reference', tool_name: 'mcp__github__search_repositories' },
            ],
          }],
        },
      ],
      tools: [
        {
          name: 'ToolSearch',
          input_schema: { type: 'object', properties: { query: { type: 'string' } } },
        },
        {
          name: 'mcp__github__get_me',
          description: 'Get the authenticated GitHub user',
          input_schema: { type: 'object', properties: {} },
        },
        {
          name: 'mcp__github__search_repositories',
          description: 'Search GitHub repositories',
          input_schema: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ],
    })

    const messages = translated.messages as any[]
    const toolResult = messages.find(message => message.role === 'tool')
    expect(toolResult.tool_call_id).toBe('tool-search-1')
    expect(toolResult.content).toContain('mcp__github__get_me')
    expect(toolResult.content).toContain('mcp__github__search_repositories')
    expect(toolResult.content).toContain('direct function calls')
    expect(toolResult.content).not.toContain('tool_reference')

    const toolNames = (translated.tools as any[])
      .map(tool => tool.function.name)
    expect(toolNames).toContain('mcp__github__get_me')
    expect(toolNames).toContain('mcp__github__search_repositories')
    expect(toolNames).not.toContain('ToolSearch')
    expect(translated.tool_choice).toBe('required')
  })

  test('restores the normal OpenAI tool pool after a referenced tool returns', () => {
    const translated = translateAnthropicRequestToOpenAI({
      model: 'GLM-5.2',
      messages: [
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-search-1',
            content: [{ type: 'tool_reference', tool_name: 'mcp__github__get_me' }],
          }],
        },
        {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'github-1',
            name: 'mcp__github__get_me',
            input: {},
          }],
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'github-1',
            content: '{"login":"test-user"}',
          }],
        },
      ],
      tools: [
        { name: 'ToolSearch', input_schema: { type: 'object', properties: {} } },
        { name: 'mcp__github__get_me', input_schema: { type: 'object', properties: {} } },
      ],
    })

    const toolNames = (translated.tools as any[]).map(tool => tool.function.name)
    expect(toolNames).toEqual(['ToolSearch', 'mcp__github__get_me'])
    expect(translated.tool_choice).toBeUndefined()
  })

  test('translates a non-streaming OpenAI response without losing its prefix', () => {
    const translated = translateOpenAIResponseToAnthropic({
      id: 'chatcmpl-1',
      model: 'deepseek-chat',
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'Opening prefix: specific advice' },
      }],
      usage: { prompt_tokens: 3, completion_tokens: 5 },
    })

    expect((translated.content as any[])[0].text).toBe('Opening prefix: specific advice')
    expect(translated.stop_reason).toBe('end_turn')
  })

  test('converts every OpenAI SSE delta, including the first one', async () => {
    const upstreamBody = [
      'data: {"id":"chatcmpl-1","model":"deepseek-chat","choices":[{"delta":{"content":"Opening prefix: "},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl-1","model":"deepseek-chat","choices":[{"delta":{"content":"specific advice"},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const requests: Array<{ url: string; body: any }> = []
    const adapter = createOpenAICompatibilityFetch({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      fetchImpl: (async (input, init) => {
        requests.push({ url: String(input), body: JSON.parse(String(init?.body)) })
        return new Response(upstreamBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }),
    })

    const response = await adapter('https://example.test/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'deepseek-chat',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    const output = await response.text()

    expect(requests[0]?.url).toBe('https://example.test/v1/chat/completions')
    expect(output).toContain('"text":"Opening prefix: "')
    expect(output).toContain('"text":"specific advice"')
    expect(output.indexOf('Opening prefix: ')).toBeLessThan(output.indexOf('specific advice'))
  })

  test('accepts a JSON chat completion even when the caller requested streaming', async () => {
    const adapter = createOpenAICompatibilityFetch({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      fetchImpl: (async () => new Response(JSON.stringify({
        id: 'chatcmpl-json',
        model: 'deepseek-chat',
        choices: [{
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'Complete JSON reply' },
        }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
    })

    const response = await adapter('https://example.test/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'deepseek-chat',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    const output = await response.text()
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(output).toContain('"text":"Complete JSON reply"')
    expect(output).toContain('"stop_reason":"end_turn"')
    expect(output).toContain('event: message_stop')
  })
})
