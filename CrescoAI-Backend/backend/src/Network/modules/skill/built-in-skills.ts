import type { SkillHandler } from './skill.registry';

function extractAssistantText(payload: any): string | null {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const text = content
      .map((part: any) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('\n')
      .trim();
    if (text) return text;
  }

  if (Array.isArray(payload?.content)) {
    const text = payload.content
      .map((part: any) => (part?.type === 'text' ? part.text : ''))
      .filter((text: any) => typeof text === 'string' && text.trim().length > 0)
      .join('\n')
      .trim();
    if (text) return text;
  }

  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  return null;
}

export interface BuiltinSkillDefinition {
  name: string;
  description: string;
  category: 'analysis' | 'generation' | 'utility';
  parameters: Array<{ name: string; description: string; required?: boolean }>;
  requiresLlm?: boolean;
  handler: SkillHandler;
}

const codeAnalysisSkill: BuiltinSkillDefinition = {
  name: 'code-analysis',
  description: 'Analyze code for quality, security issues, and improvement suggestions',
  category: 'analysis',
  parameters: [
    { name: 'code', description: 'Code snippet or description to analyze', required: true },
  ],
  requiresLlm: true,
  handler: async (args, context) => {
    const code = args.trim();
    if (!code) {
      return {
        success: false,
        reply: 'Please provide code to analyze. Usage: /code-analysis <code or description>',
      };
    }

    const llmConfig = context?.llmConfig;
    if (!llmConfig?.apiKey || !llmConfig?.baseUrl) {
      return {
        success: false,
        reply: 'Code analysis requires LLM configuration. Please set your API key in Settings first.',
      };
    }

    if (context?.runUnifiedPrompt) {
      const result = await context.runUnifiedPrompt({
        userId: context.userId,
        conversationId: context.conversationId,
        apiKey: llmConfig.apiKey,
        baseUrl: llmConfig.baseUrl,
        model: llmConfig.model,
        content:
          'You are a code analysis expert. Analyze the provided code for:\n' +
          '1. Security vulnerabilities\n' +
          '2. Performance issues\n' +
          '3. Code quality and best practices\n' +
          '4. Improvement suggestions\n\n' +
          'Respond in a clear, structured format using markdown.\n\n' +
          `Analyze this code:\n\n${code}`,
      });

      if (!result.success || !result.reply) {
        return { success: false, reply: 'Code analysis failed via unified query engine.' };
      }

      return {
        success: true,
        reply: result.reply,
        outputFiles: result.generatedFiles,
        metadata: { model: result.model ?? llmConfig.model },
      };
    }

    const baseUrl = llmConfig.baseUrl.replace(/\/+$/, '');
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${llmConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: llmConfig.model ?? 'glm-4',
          messages: [
            {
              role: 'system',
              content: 'You are a code analysis expert. Analyze the provided code for:\n1. Security vulnerabilities\n2. Performance issues\n3. Code quality and best practices\n4. Improvement suggestions\n\nRespond in a clear, structured format using markdown.',
            },
            { role: 'user', content: `Analyze this code:\n\n${code}` },
          ],
          max_tokens: 4096,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(180000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, reply: `Code analysis API error (${response.status}): ${errorText}` };
      }

      const data = (await response.json()) as any;
      const reply = extractAssistantText(data) ?? 'No analysis result returned.';

      return {
        success: true,
        reply,
        metadata: {
          model: data.model ?? llmConfig.model,
          usage: data.usage
            ? { input_tokens: data.usage.prompt_tokens, output_tokens: data.usage.completion_tokens }
            : undefined,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        reply: `Code analysis failed: ${error?.message ?? 'Unknown error'}`,
      };
    }
  },
};

const builtinSkills: BuiltinSkillDefinition[] = [codeAnalysisSkill];

export function registerBuiltinSkills(
  registerFn: (entry: Omit<import('./skill.registry').SkillEntry, 'status'>) => void,
): void {
  for (const skill of builtinSkills) {
    registerFn({
      name: skill.name,
      description: skill.description,
      category: skill.category,
      source: 'builtin',
      parameters: skill.parameters,
      requiresLlm: skill.requiresLlm,
      handler: skill.handler,
    });
  }
}
