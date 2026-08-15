import { randomUUID } from 'node:crypto'

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

interface OpenAICompatibilityFetchOptions {
  apiKey?: string
  baseUrl: string
  fetchImpl?: FetchLike
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeFunctionParameters(value: unknown): UnknownRecord {
  if (!isRecord(value)) {
    return { type: 'object', properties: {} }
  }

  // OpenAI-compatible function calling requires the root parameters schema to
  // be an object. Zod unions of object schemas serialize with a root `anyOf`
  // and no `type`, which DeepSeek rejects as `type: null`. Keep the union
  // constraints while making the function-argument container explicit.
  if (value.type !== 'object') {
    return { ...value, type: 'object' }
  }

  return value
}

export function isOpenAICompatibleProvider(provider: string | undefined): boolean {
  const normalized = provider?.trim().toLowerCase().replace(/[_\s]+/g, '-')
  return normalized === 'openai' || normalized === 'openai-compatible' || normalized === 'openrouter'
}

function buildChatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(normalized)) {
    return normalized
  }
  if (/\/v1$/i.test(normalized)) {
    return `${normalized}/chat/completions`
  }
  return `${normalized}/v1/chat/completions`
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  const toolReferences: string[] = []
  const text = value
    .map(item => {
      if (typeof item === 'string') return item
      if (!isRecord(item)) return ''
      if (typeof item.text === 'string') return item.text
      if (typeof item.content === 'string') return item.content
      if (item.type === 'tool_reference' && typeof item.tool_name === 'string') {
        toolReferences.push(item.tool_name)
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')

  if (!toolReferences.length) return text

  const loadedTools = [...new Set(toolReferences)]
  const toolReferenceText =
    `Loaded tools are now available for direct function calls: ${loadedTools.join(', ')}. ` +
    'Call the appropriate loaded tool directly; do not search for these same tools again.'
  return [text, toolReferenceText].filter(Boolean).join('\n')
}

function getImmediateToolReferences(messages: unknown): Set<string> {
  if (!Array.isArray(messages) || messages.length === 0) return new Set()
  const latestMessage = messages[messages.length - 1]
  if (!isRecord(latestMessage) || !Array.isArray(latestMessage.content)) {
    return new Set()
  }

  const references = new Set<string>()
  for (const block of latestMessage.content) {
    if (!isRecord(block) || block.type !== 'tool_result' || !Array.isArray(block.content)) {
      continue
    }
    for (const item of block.content) {
      if (
        isRecord(item) &&
        item.type === 'tool_reference' &&
        typeof item.tool_name === 'string'
      ) {
        references.add(item.tool_name)
      }
    }
  }
  return references
}

function translateUserContent(content: unknown): UnknownRecord[] {
  if (typeof content === 'string') {
    return [{ role: 'user', content }]
  }
  if (!Array.isArray(content)) {
    return [{ role: 'user', content: '' }]
  }

  const output: UnknownRecord[] = []
  let publicParts: UnknownRecord[] = []
  const flushPublicParts = () => {
    if (!publicParts.length) return
    output.push({ role: 'user', content: publicParts })
    publicParts = []
  }

  for (const item of content) {
    if (!isRecord(item)) continue
    if (item.type === 'tool_result') {
      flushPublicParts()
      output.push({
        role: 'tool',
        tool_call_id: String(item.tool_use_id ?? item.toolUseId ?? ''),
        content: textFromContent(item.content),
      })
      continue
    }
    if (item.type === 'text' && typeof item.text === 'string') {
      publicParts.push({ type: 'text', text: item.text })
      continue
    }
    if (item.type === 'image' && isRecord(item.source)) {
      const source = item.source
      const url = source.type === 'base64'
        ? `data:${String(source.media_type ?? 'image/png')};base64,${String(source.data ?? '')}`
        : String(source.url ?? '')
      if (url) publicParts.push({ type: 'image_url', image_url: { url } })
    }
  }
  flushPublicParts()
  return output.length ? output : [{ role: 'user', content: '' }]
}

function translateAssistantContent(content: unknown): UnknownRecord {
  if (typeof content === 'string') return { role: 'assistant', content }
  const textParts: string[] = []
  const toolCalls: UnknownRecord[] = []
  for (const item of Array.isArray(content) ? content : []) {
    if (!isRecord(item)) continue
    if (item.type === 'text' && typeof item.text === 'string') {
      textParts.push(item.text)
    } else if (item.type === 'tool_use') {
      toolCalls.push({
        id: String(item.id ?? ''),
        type: 'function',
        function: {
          name: String(item.name ?? ''),
          arguments: JSON.stringify(item.input ?? {}),
        },
      })
    }
  }
  return {
    role: 'assistant',
    content: textParts.join('\n') || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  }
}

export function translateAnthropicRequestToOpenAI(input: UnknownRecord): UnknownRecord {
  const messages: UnknownRecord[] = []
  const systemText = textFromContent(input.system)
  if (systemText) messages.push({ role: 'system', content: systemText })

  for (const message of Array.isArray(input.messages) ? input.messages : []) {
    if (!isRecord(message)) continue
    if (message.role === 'assistant') {
      messages.push(translateAssistantContent(message.content))
    } else {
      messages.push(...translateUserContent(message.content))
    }
  }

  const allTools = (Array.isArray(input.tools) ? input.tools : [])
    .filter(isRecord)
    .map(tool => ({
      type: 'function',
      function: {
        name: String(tool.name ?? ''),
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        parameters: normalizeFunctionParameters(tool.input_schema),
      },
    }))

  // Anthropic expands tool_reference blocks server-side and expects the model
  // to call one of those tools next. OpenAI-compatible APIs have no equivalent
  // protocol, so emulate that transition for exactly the immediate follow-up:
  // expose only the referenced schemas and require one function call. Once the
  // real tool returns, the latest message no longer contains tool_reference and
  // the normal tool pool is restored.
  const immediateToolReferences = getImmediateToolReferences(input.messages)
  const referencedTools = immediateToolReferences.size
    ? allTools.filter(tool => {
        const fn = isRecord(tool.function) ? tool.function : undefined
        return typeof fn?.name === 'string' && immediateToolReferences.has(fn.name)
      })
    : []
  const isToolReferenceFollowUp = referencedTools.length > 0
  const tools = isToolReferenceFollowUp ? referencedTools : allTools

  const toolChoice = isToolReferenceFollowUp
    ? 'required'
    : isRecord(input.tool_choice)
      ? input.tool_choice.type === 'tool'
        ? { type: 'function', function: { name: String(input.tool_choice.name ?? '') } }
        : input.tool_choice.type === 'any'
          ? 'required'
          : input.tool_choice.type === 'auto'
            ? 'auto'
            : undefined
      : undefined

  return {
    model: input.model,
    messages,
    stream: input.stream === true,
    ...(input.stream === true ? { stream_options: { include_usage: true } } : {}),
    ...(typeof input.max_tokens === 'number' ? { max_tokens: input.max_tokens } : {}),
    ...(typeof input.temperature === 'number' ? { temperature: input.temperature } : {}),
    ...(typeof input.top_p === 'number' ? { top_p: input.top_p } : {}),
    ...(input.stop_sequences ? { stop: input.stop_sequences } : {}),
    ...(tools.length ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  }
}

function mapUsage(value: unknown) {
  const usage = isRecord(value) ? value : {}
  return {
    input_tokens: Number(usage.prompt_tokens ?? 0),
    output_tokens: Number(usage.completion_tokens ?? 0),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
}

function mapStopReason(reason: unknown): string {
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use'
  if (reason === 'length') return 'max_tokens'
  if (reason === 'content_filter') return 'refusal'
  return 'end_turn'
}

function openAIText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map(item => isRecord(item) && typeof item.text === 'string' ? item.text : '')
    .join('')
}

export function translateOpenAIResponseToAnthropic(input: UnknownRecord): UnknownRecord {
  const choice = Array.isArray(input.choices) && isRecord(input.choices[0]) ? input.choices[0] : {}
  const message = isRecord(choice.message) ? choice.message : {}
  const content: UnknownRecord[] = []
  const reasoning = openAIText(
    message.reasoning_content ?? message.reasoning ?? message.thinking,
  )
  if (reasoning) content.push({ type: 'thinking', thinking: reasoning, signature: '' })
  const text = openAIText(message.content)
  if (text) content.push({ type: 'text', text })
  for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (!isRecord(toolCall)) continue
    const fn = isRecord(toolCall.function) ? toolCall.function : {}
    let parsedInput: unknown = {}
    try {
      parsedInput = JSON.parse(String(fn.arguments ?? '{}'))
    } catch {
      parsedInput = {}
    }
    content.push({
      type: 'tool_use',
      id: String(toolCall.id ?? `call_${randomUUID()}`),
      name: String(fn.name ?? 'unknown_tool'),
      input: parsedInput,
    })
  }
  return {
    id: String(input.id ?? `msg_${randomUUID()}`),
    type: 'message',
    role: 'assistant',
    model: String(input.model ?? 'openai-compatible'),
    content,
    stop_reason: mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: mapUsage(input.usage),
  }
}

class OpenAIStreamTranslator {
  private started = false
  private finished = false
  private messageId = `msg_${randomUUID()}`
  private model = 'openai-compatible'
  private nextBlockIndex = 0
  private textBlockIndex: number | null = null
  private thinkingBlockIndex: number | null = null
  private toolBlocks = new Map<number, { blockIndex: number; id: string; name: string }>()
  private finishReason: unknown = null
  private usage: unknown = null

  push(chunk: UnknownRecord): UnknownRecord[] {
    const output: UnknownRecord[] = []
    if (typeof chunk.id === 'string') this.messageId = chunk.id
    if (typeof chunk.model === 'string') this.model = chunk.model
    if (chunk.usage) this.usage = chunk.usage
    if (!this.started) {
      this.started = true
      output.push({
        type: 'message_start',
        message: {
          id: this.messageId,
          type: 'message',
          role: 'assistant',
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: mapUsage(undefined),
        },
      })
    }

    const choice = Array.isArray(chunk.choices) && isRecord(chunk.choices[0]) ? chunk.choices[0] : {}
    const delta = isRecord(choice.delta)
      ? choice.delta
      : isRecord(choice.message)
        ? choice.message
        : {}
    const reasoning = openAIText(delta.reasoning_content ?? delta.reasoning ?? delta.thinking)
    if (reasoning) {
      if (this.thinkingBlockIndex === null) {
        this.thinkingBlockIndex = this.nextBlockIndex++
        output.push({
          type: 'content_block_start',
          index: this.thinkingBlockIndex,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        })
      }
      output.push({
        type: 'content_block_delta',
        index: this.thinkingBlockIndex,
        delta: { type: 'thinking_delta', thinking: reasoning },
      })
    }

    const text = openAIText(delta.content ?? choice.text)
    if (text) {
      if (this.textBlockIndex === null) {
        this.textBlockIndex = this.nextBlockIndex++
        output.push({
          type: 'content_block_start',
          index: this.textBlockIndex,
          content_block: { type: 'text', text: '', citations: [] },
        })
      }
      output.push({
        type: 'content_block_delta',
        index: this.textBlockIndex,
        delta: { type: 'text_delta', text },
      })
    }

    for (const rawToolCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      if (!isRecord(rawToolCall)) continue
      const toolIndex = Number(rawToolCall.index ?? 0)
      const fn = isRecord(rawToolCall.function) ? rawToolCall.function : {}
      let tool = this.toolBlocks.get(toolIndex)
      if (!tool) {
        tool = {
          blockIndex: this.nextBlockIndex++,
          id: String(rawToolCall.id ?? `call_${randomUUID()}`),
          name: String(fn.name ?? 'unknown_tool'),
        }
        this.toolBlocks.set(toolIndex, tool)
        output.push({
          type: 'content_block_start',
          index: tool.blockIndex,
          content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} },
        })
      }
      if (typeof fn.arguments === 'string' && fn.arguments) {
        output.push({
          type: 'content_block_delta',
          index: tool.blockIndex,
          delta: { type: 'input_json_delta', partial_json: fn.arguments },
        })
      }
    }

    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      this.finishReason = choice.finish_reason
    }
    return output
  }

  finish(): UnknownRecord[] {
    if (this.finished) return []
    this.finished = true
    const output: UnknownRecord[] = []
    if (!this.started) {
      output.push(...this.push({ choices: [] }))
    }
    const openIndexes = [
      this.thinkingBlockIndex,
      this.textBlockIndex,
      ...[...this.toolBlocks.values()].map(tool => tool.blockIndex),
    ].filter((index): index is number => index !== null)
    for (const index of openIndexes) {
      output.push({ type: 'content_block_stop', index })
    }
    output.push({
      type: 'message_delta',
      delta: { stop_reason: mapStopReason(this.finishReason), stop_sequence: null },
      usage: mapUsage(this.usage),
    })
    output.push({ type: 'message_stop' })
    return output
  }
}

function encodeAnthropicSse(events: UnknownRecord[]): string {
  return events
    .map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('')
}

function translateOpenAIJsonToAnthropicStream(input: UnknownRecord): Response {
  const translator = new OpenAIStreamTranslator()
  const events = [
    ...translator.push(input),
    ...translator.finish(),
  ]
  return new Response(encodeAnthropicSse(events), {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    },
  })
}

function translateOpenAIStream(response: Response): Response {
  if (!response.body) return response
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const translator = new OpenAIStreamTranslator()
  let buffer = ''

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { value, done } = await reader.read()
          buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n')
          if (done && buffer && !buffer.endsWith('\n')) buffer += '\n'

          let newline = buffer.indexOf('\n')
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            newline = buffer.indexOf('\n')
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (!data) continue
            if (data === '[DONE]') {
              controller.enqueue(encoder.encode(encodeAnthropicSse(translator.finish())))
              controller.close()
              await reader.cancel().catch(() => {})
              return
            }
            try {
              const parsed = JSON.parse(data)
              if (isRecord(parsed)) {
                const events = translator.push(parsed)
                if (events.length) {
                  controller.enqueue(encoder.encode(encodeAnthropicSse(events)))
                }
              }
            } catch {
              // Ignore malformed/non-JSON SSE bookkeeping lines.
            }
          }
          if (done) {
            controller.enqueue(encoder.encode(encodeAnthropicSse(translator.finish())))
            controller.close()
            return
          }
        }
      } catch (error) {
        controller.error(error)
      }
    },
    cancel() {
      return reader.cancel()
    },
  })

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    },
  })
}

async function readRequestJson(input: RequestInfo | URL, init?: RequestInit): Promise<UnknownRecord | null> {
  const body = init?.body
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body)
      return isRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  if (input instanceof Request) {
    try {
      const parsed = await input.clone().json()
      return isRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

export function createOpenAICompatibilityFetch(
  options: OpenAICompatibilityFetchOptions,
): FetchLike {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!/\/messages(?:\?|$)/i.test(url)) {
      return fetchImpl(input, init)
    }

    const anthropicRequest = await readRequestJson(input, init)
    if (!anthropicRequest) return fetchImpl(input, init)
    const openAIRequest = translateAnthropicRequestToOpenAI(anthropicRequest)
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
    headers.delete('x-api-key')
    headers.delete('anthropic-version')
    headers.delete('anthropic-beta')
    headers.set('content-type', 'application/json')
    headers.set('accept', openAIRequest.stream ? 'text/event-stream' : 'application/json')
    if (options.apiKey) headers.set('authorization', `Bearer ${options.apiKey}`)

    const response = await fetchImpl(buildChatCompletionsUrl(options.baseUrl), {
      ...init,
      method: 'POST',
      headers,
      body: JSON.stringify(openAIRequest),
    })
    if (!response.ok) return response
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (openAIRequest.stream === true && contentType.includes('text/event-stream')) {
      return translateOpenAIStream(response)
    }

    const parsed = await response.json()
    if (!isRecord(parsed)) return response
    if (openAIRequest.stream === true) {
      return translateOpenAIJsonToAnthropicStream(parsed)
    }
    return new Response(JSON.stringify(translateOpenAIResponseToAnthropic(parsed)), {
      status: response.status,
      statusText: response.statusText,
      headers: { 'content-type': 'application/json' },
    })
  }
}
