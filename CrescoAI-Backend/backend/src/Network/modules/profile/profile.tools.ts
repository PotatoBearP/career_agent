import { z } from 'zod/v4';
import { buildTool, type Tool, type ToolDef } from '../../../Tool.js';
import { lazySchema } from '../../../utils/lazySchema.js';
import {
  PROFILE_LEVEL_CLASSIFICATION_PROMPT,
  PROFILE_MEMORY_SCOPE_PROMPT,
} from './profile-agent.prompt';
import { profileFeatureFlags } from './profile-feature-flags';
import type { ProfileMemoryService } from './profile-memory.service';
import type { ProfileProposalService } from './profile-proposal.service';
import type { ProfileV2Service } from './profile-v2.service';
import type { ProfileRecallService } from './profile-recall.service';
import type { ProfileProductProjectionService } from './profile-product-projection.service';
import type { ProfileProductMutationService } from './profile-product-mutation.service';
import { PROFILE_PRODUCT_FIELD_KEYS } from './profile-product.types';

export interface ProfileToolRuntime {
  userId: number;
  conversationId: string;
  sourceMessageId?: string | (() => string | null | undefined);
  baseService: ProfileV2Service;
  memoryService: ProfileMemoryService;
  proposalService: ProfileProposalService;
  recallService?: ProfileRecallService;
  productProjectionService?: ProfileProductProjectionService;
  productMutationService?: ProfileProductMutationService;
}

type ProfileReadMode = 'summary' | 'relevant';

const resultSchema = lazySchema(() => z.object({ result: z.unknown() }));
const common = {
  maxResultSizeChars: 40_000,
  strict: true,
  isEnabled: () => profileFeatureFlags.tools(),
  isConcurrencySafe: () => false,
  async checkPermissions(input: Record<string, unknown>) {
    return { behavior: 'allow' as const, updatedInput: input };
  },
  renderToolUseMessage: () => null,
  userFacingName: () => 'Profile',
  mapToolResultToToolResultBlockParam(data: { result: unknown }, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: JSON.stringify(data.result),
    };
  },
};

async function readMemory(
  runtime: ProfileToolRuntime,
  mode: ProfileReadMode,
  query?: string,
) {
  if (mode === 'relevant' && runtime.recallService) {
    return {
      data: await runtime.recallService.buildContext(runtime.userId, query ?? ''),
      degraded: false,
    };
  }
  const items = await runtime.memoryService.list(runtime.userId, { status: 'active' });
  if (profileFeatureFlags.indexedMutations()) {
    return {
      data: {
        L1: items.filter((item) => item.profileLevel === 'L1'),
        L2: items.filter((item) => item.profileLevel === 'L2'),
        L3: items.filter((item) => item.profileLevel === 'L3'),
        total: items.length,
      },
      degraded: mode === 'relevant',
    };
  }
  return {
    data: {
      hardConstraints: items.filter((item) => item.priority === 'hard_constraint'),
      shortTerm: items.filter((item) => item.timeScope === 'short_term'),
      longTerm: items.filter((item) => item.timeScope === 'long_term'),
      total: items.length,
    },
    degraded: mode === 'relevant',
  };
}

export function createCompactProfileTools(runtime: ProfileToolRuntime): Tool[] {
  if (
    profileFeatureFlags.productAgentWorkflow()
    && runtime.productProjectionService
    && runtime.productMutationService
  ) {
    return createProductProfileTools(runtime);
  }
  const readInput = lazySchema(() => z.union([
    z.strictObject({ source: z.literal('basic') }),
    z.strictObject({
      source: z.literal('memory'),
      mode: z.literal('summary'),
    }),
    z.strictObject({
      source: z.literal('memory'),
      mode: z.literal('relevant'),
      query: z.string().min(1).max(2_000),
    }),
  ]));
  const updateInput = lazySchema(() => {
    const basic = z.strictObject({
      target: z.literal('basic'),
      patch: z.record(z.string(), z.unknown()),
      sourceType: z.enum(['user_explicit', 'user_confirmed', 'system_correction']),
      rationale: z.string().min(1).max(2_000),
    });
    const sourceType = z.enum(['user_explicit', 'user_confirmed', 'agent_summary', 'multi_conversation_summary']);
    const priority = z.enum(['hard_constraint', 'high', 'normal', 'background']);
    if (profileFeatureFlags.indexedMutations()) {
      return z.union([
        z.strictObject({
          target: z.literal('memory'),
          operation: z.literal('add'),
          content: z.string().min(1).max(2_000),
          category: z.string().min(1).max(100),
          slotKey: z.string().max(150).optional(),
          appliesTo: z.array(z.string()).max(20).optional(),
          timeScope: z.enum(['long_term', 'short_term']),
          priority,
          level: z.enum(['L1', 'L2', 'L3']),
          sourceType,
          expiresAt: z.string().nullable().optional(),
          rationale: z.string().min(1).max(2_000),
        }),
        z.strictObject({
          target: z.literal('memory'),
          operation: z.literal('replace'),
          profileIndex: z.string().regex(/^P\d{6,}$/),
          content: z.string().min(1).max(2_000),
          category: z.string().min(1).max(100).optional(),
          slotKey: z.string().max(150).optional(),
          appliesTo: z.array(z.string()).max(20).optional(),
          timeScope: z.enum(['long_term', 'short_term']).optional(),
          priority: priority.optional(),
          level: z.enum(['L1', 'L2', 'L3']),
          sourceType,
          expiresAt: z.string().nullable().optional(),
          rationale: z.string().min(1).max(2_000),
        }),
        basic,
      ]);
    }
    return z.union([
      z.strictObject({
        target: z.literal('memory'),
        content: z.string().min(1).max(2_000),
        category: z.string().min(1).max(100),
        slotKey: z.string().max(150).optional(),
        appliesTo: z.array(z.string()).max(20).optional(),
        timeScope: z.enum(['long_term', 'short_term', 'temporary']),
        priority,
        level: z.enum(['L0', 'L1', 'L2', 'L3']),
        sourceType,
        expiresAt: z.string().nullable().optional(),
        rationale: z.string().min(1).max(2_000),
      }),
      basic,
    ]);
  });

  return [
    buildTool({
      ...common,
      name: 'profile_read',
      schemaCacheNamespace: 'compact-profile-interactive',
      isReadOnly: () => true,
      searchHint: 'read authenticated user career profile or relevant career memory',
      async description() { return 'Read career-specific Profile data. Set source=basic for identity, education, location, and current employment facts; use source=memory for career goals, target roles, job preferences, and employment constraints. Do not use Profile for generic user preferences or project context.'; },
      async prompt() { return `${PROFILE_MEMORY_SCOPE_PROMPT}\n\nUse source=basic only when stable career facts are needed. Use source=memory, mode=relevant with the current query for normal career tasks; reserve summary for Profile management and before choosing a profileIndex to replace.`; },
      get inputSchema() { return readInput(); },
      get outputSchema() { return resultSchema(); },
      async call(input) {
        if (input.source === 'basic') {
          return { data: { result: {
            source: 'basic',
            data: await runtime.baseService.getBaseProfile(runtime.userId),
          } } };
        }
        const result = await readMemory(runtime, input.mode, input.query);
        return { data: { result: {
          source: 'memory',
          mode: input.mode,
          ...result,
        } } };
      },
    } satisfies ToolDef<any, any>),
    buildTool({
      ...common,
      name: 'profile_update',
      schemaCacheNamespace: 'compact-profile-interactive',
      searchHint: 'classify and update authenticated user career profile or career memory',
      async description() {
        return profileFeatureFlags.indexedMutations()
          ? 'Update career-specific Profile data such as employment facts, target roles, career direction, salary expectations, job-search preferences, and employment constraints. For target=memory choose operation=add or replace; target=basic updates stable career facts. Non-career durable context belongs to auto-memory.'
          : 'Update career-specific Profile data through one strict target branch. target=memory submits an L0-L3 career candidate; target=basic submits an L3 stable career-fact change. Non-career durable context belongs to auto-memory.';
      },
      async prompt() {
        const workflow = profileFeatureFlags.indexedMutations()
          ? 'For memory add, never provide profileIndex. For memory replace, first read the item and provide its exact profileIndex; never guess an index. The submitted level classifies the resulting content, while replace is audited as updateLevel L3.'
          : 'Use target=memory for career goals, employment preferences, and job-search constraints.';
        return `${PROFILE_MEMORY_SCOPE_PROMPT}\n\n${PROFILE_LEVEL_CLASSIFICATION_PROMPT}\n\n${workflow} Use target=basic only for explicitly stated stable career facts. L1-L3 auto-apply by default, but the server may ignore prohibited content, correct the content level, report a conflict, or create a proposal when an auto-apply flag is disabled.`;
      },
      get inputSchema() { return updateInput(); },
      get outputSchema() { return resultSchema(); },
      async call(input) {
        if (input.target === 'basic') {
          const proposal = await runtime.proposalService.proposeBase(runtime.userId, {
            patch: input.patch,
            sourceType: input.sourceType,
            rationale: input.rationale,
            sourceConversationId: runtime.conversationId,
          });
          const applied = proposal.status === 'applied';
          return { data: { result: {
            target: 'basic',
            outcome: applied ? 'applied' : 'proposed',
            submittedLevel: 'L3',
            finalLevel: 'L3',
            confirmationRequired: !applied && proposal.confirmationRequired,
            reasons: applied
              ? ['L3 base Profile update was applied']
              : ['L3 requires confirmation because auto-apply is disabled or this is an existing legacy proposal'],
            proposalId: proposal.id,
            data: proposal,
          } } };
        }

        const submittedLevel = input.level;
        const update = await runtime.proposalService.proposeMemory(runtime.userId, {
          operation: profileFeatureFlags.indexedMutations() ? input.operation : undefined,
          profileIndex: profileFeatureFlags.indexedMutations() ? input.profileIndex : undefined,
          content: input.content,
          category: input.category,
          slotKey: input.slotKey,
          appliesTo: input.appliesTo,
          timeScope: input.timeScope,
          priority: input.priority,
          level: input.level,
          sourceType: input.sourceType,
          expiresAt: input.expiresAt,
          rationale: input.rationale,
          sourceConversationId: runtime.conversationId,
        });
        const outcome = update.mutationOutcome
          ?? (update.decision.action === 'ignore'
            ? 'ignored'
            : update.appliedMemory || update.proposal?.status === 'applied'
              ? 'applied'
              : 'proposed');
        const data = update.appliedMemory ?? update.proposal;
        return { data: { result: {
          target: 'memory',
          operation: input.operation ?? 'add',
          outcome,
          profileIndex: update.appliedMemory?.profileIndex ?? input.profileIndex ?? null,
          submittedProfileLevel: submittedLevel,
          finalProfileLevel: update.profileLevel ?? update.decision.level,
          updateLevel: update.decision.level,
          submittedLevel,
          finalLevel: update.decision.level,
          confirmationRequired: update.decision.confirmationRequired,
          reasons: update.decision.reasons,
          proposalId: update.proposal?.id,
          data,
        } } };
      },
    } satisfies ToolDef<any, any>),
  ];
}

export function createProductProfileTools(runtime: ProfileToolRuntime): Tool[] {
  const readInput = lazySchema(() => z.union([
    z.strictObject({ source: z.literal('product') }),
    z.strictObject({
      source: z.literal('relevant'),
      query: z.string().min(1).max(2_000),
    }),
  ]));
  const updateInput = lazySchema(() => z.strictObject({
    fieldKey: z.enum(PROFILE_PRODUCT_FIELD_KEYS),
    operation: z.enum(['set', 'clear', 'add', 'remove']),
    value: z.union([
      z.string().max(2_000),
      z.array(z.string().max(500)).max(50),
      z.number().min(0).max(80),
      z.null(),
    ]).optional(),
    evidence: z.enum([
      'current_user_explicit',
      'recalled_user_explicit',
      'grounded_summary',
    ]),
    rationale: z.string().min(1).max(1_000),
  }));

  return [
    buildTool({
      ...common,
      name: 'profile_read',
      schemaCacheNamespace: 'product-profile-interactive',
      isReadOnly: () => true,
      searchHint: 'read the authenticated user product career and education profile',
      async description() {
        return 'Read the current product career, education, and learning Profile. Use source=product before Profile management; use source=relevant when the current career task only needs relevant Profile context.';
      },
      async prompt() {
        return `${PROFILE_MEMORY_SCOPE_PROMPT}\n\nThe product view uses stable fieldKey values and never exposes internal Profile levels, indexes, source ids, or storage paths. Read before changing an existing field when its current value matters.`;
      },
      get inputSchema() { return readInput(); },
      get outputSchema() { return resultSchema(); },
      async call(input) {
        if (input.source === 'relevant' && runtime.recallService) {
          return { data: { result: {
            source: 'relevant',
            data: await runtime.recallService.buildContext(runtime.userId, input.query),
          } } };
        }
        return { data: { result: {
          source: 'product',
          data: await runtime.productProjectionService!.getProductProfile(runtime.userId),
        } } };
      },
    } satisfies ToolDef<any, any>),
    buildTool({
      ...common,
      name: 'profile_update',
      schemaCacheNamespace: 'product-profile-interactive',
      searchHint: 'automatically update one grounded product career or education profile field',
      async description() {
        return 'Automatically set or clear one stable product Profile field after the user explicitly provides a durable career, education, or learning fact. The server owns internal levels, slots, versioning, and audit.';
      },
      async prompt() {
        return `${PROFILE_MEMORY_SCOPE_PROMPT}\n\nUpdate exactly one field per call. If the evidence contains multiple independently representable durable facts, make one call for every applicable field before answering; a no_change result covers only the requested field and does not save any other fact. Never choose an unrelated existing field as a substitute for the evidence. Use base.educationLevel and education.* fields for education facts; never put school, major, degree, or study year in base.currentRole, and never infer base.currentCity from a school's location. For list fields, prefer add/remove so an incremental fact cannot erase existing items; set replaces the full field and requires explicit complete replacement evidence. Use current_user_explicit only for facts stated in the current user turn, recalled_user_explicit only for a recalled attributable user statement, and grounded_summary only for a conservative synthesis supported by saved facts. Temporary task filters, assistant suggestions, questions asked, and content merely read are not Profile changes. Do not narrate the update after the tool returns.`;
      },
      get inputSchema() { return updateInput(); },
      get outputSchema() { return resultSchema(); },
      async call(input) {
        const before = await runtime.productProjectionService!.getProductProfile(runtime.userId);
        const sourceType = input.evidence === 'current_user_explicit'
          ? 'user_explicit' as const
          : input.evidence === 'recalled_user_explicit'
            ? 'multi_conversation_summary' as const
            : 'agent_summary' as const;
        let after;
        try {
          after = await runtime.productMutationService!.mutate(runtime.userId, {
            expectedVersion: before.version,
            fieldKey: input.fieldKey,
            operation: input.operation,
            value: input.value,
          }, {
            actorType: 'agent',
            sourceType,
            sourceConversationId: runtime.conversationId,
            sourceMessageId: typeof runtime.sourceMessageId === 'function'
              ? runtime.sourceMessageId() ?? null
              : runtime.sourceMessageId ?? null,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.toLowerCase().includes('version')) throw error;
          const latest = await runtime.productProjectionService!.getProductProfile(runtime.userId);
          after = await runtime.productMutationService!.mutate(runtime.userId, {
            expectedVersion: latest.version,
            fieldKey: input.fieldKey,
            operation: input.operation,
            value: input.value,
          }, {
            actorType: 'agent',
            sourceType,
            sourceConversationId: runtime.conversationId,
            sourceMessageId: typeof runtime.sourceMessageId === 'function'
              ? runtime.sourceMessageId() ?? null
              : runtime.sourceMessageId ?? null,
          });
        }
        return { data: { result: {
          target: 'product_profile',
          field: input.fieldKey,
          outcome: after.version === before.version ? 'no_change' : 'applied',
          profileVersion: after.version,
        } } };
      },
    } satisfies ToolDef<any, any>),
  ];
}

export function createLegacyProfileTools(runtime: ProfileToolRuntime): Tool[] {
  const getBasicInput = lazySchema(() => z.strictObject({}));
  const readMemoryInput = lazySchema(() => z.strictObject({
    mode: z.enum(['summary', 'relevant']).default('summary'),
    query: z.string().max(2_000).optional(),
  }));
  const proposeMemoryInput = lazySchema(() => z.strictObject({
    content: z.string().min(1).max(2_000),
    category: z.string().min(1).max(100),
    slotKey: z.string().max(150).optional(),
    appliesTo: z.array(z.string()).max(20).optional(),
    timeScope: z.enum(['long_term', 'short_term', 'temporary']),
    priority: z.enum(['hard_constraint', 'high', 'normal', 'background']),
    level: z.enum(['L0', 'L1', 'L2', 'L3']),
    sourceType: z.enum(['user_explicit', 'user_confirmed', 'agent_summary', 'multi_conversation_summary']),
    expiresAt: z.string().nullable().optional(),
    rationale: z.string().min(1).max(2_000),
  }));
  const updateBasicInput = lazySchema(() => z.strictObject({
    patch: z.record(z.string(), z.unknown()),
    sourceType: z.enum(['user_explicit', 'user_confirmed', 'system_correction']),
    rationale: z.string().min(1).max(2_000),
  }));
  const applyInput = lazySchema(() => z.strictObject({ proposalId: z.string().uuid() }));

  const tools: Tool[] = [
    buildTool({
      ...common,
      name: 'profile_get_basic',
      isReadOnly: () => true,
      searchHint: 'read authenticated user base career profile',
      async description() { return 'Read the authenticated user base Profile and missing fields. No user id parameter is accepted.'; },
      async prompt() { return `${PROFILE_MEMORY_SCOPE_PROMPT}\n\nUse this when stable identity, education, location, or current career status is relevant.`; },
      get inputSchema() { return getBasicInput(); },
      get outputSchema() { return resultSchema(); },
      async call() { return { data: { result: await runtime.baseService.getBaseProfile(runtime.userId) } }; },
    } satisfies ToolDef<any, any>),
    buildTool({
      ...common,
      name: 'profile_memory_read',
      isReadOnly: () => true,
      searchHint: 'read authenticated user career memory summary or relevant items',
      async description() { return 'Read active career-specific Profile Memory for the authenticated user. Deleted, expired, and superseded items are excluded. Generic preferences and project context belong to auto-memory.'; },
      async prompt() { return `${PROFILE_MEMORY_SCOPE_PROMPT}\n\nUse relevant mode with the current career query; use summary only for Profile management.`; },
      get inputSchema() { return readMemoryInput(); },
      get outputSchema() { return resultSchema(); },
      async call(input) {
        const result = await readMemory(runtime, input.mode, input.query);
        return { data: { result: result.data } };
      },
    } satisfies ToolDef<any, any>),
    buildTool({
      ...common,
      name: 'profile_memory_propose',
      searchHint: 'classify grounded career profile memory as L0, L1, L2, or L3 and submit it to policy',
      async description() { return 'Classify a grounded career-specific Profile Memory candidate as L0-L3 and submit it for deterministic server validation. Non-career durable context belongs to auto-memory. L0 is ignored; L1-L3 auto-apply by default and can be changed to proposals by feature flags.'; },
      async prompt() {
        return `${PROFILE_MEMORY_SCOPE_PROMPT}\n\n${PROFILE_LEVEL_CLASSIFICATION_PROMPT}\n\nBefore calling, choose exactly one level. Do not provide a numeric confidence. The server may reject prohibited content or raise the risk level for hard constraints and conflicts, but it will not use a confidence score to classify the candidate.`;
      },
      get inputSchema() { return proposeMemoryInput(); },
      get outputSchema() { return resultSchema(); },
      async call(input) {
        return { data: { result: await runtime.proposalService.proposeMemory(runtime.userId, {
          ...input,
          sourceConversationId: runtime.conversationId,
        }) } };
      },
    } satisfies ToolDef<any, any>),
    buildTool({
      ...common,
      name: 'profile_update_basic',
      searchHint: 'submit an L3 base profile change',
      async description() { return 'Submit an L3 base Profile change. It auto-applies by default and becomes a confirmation proposal when L3 auto-apply is disabled.'; },
      async prompt() { return `${PROFILE_MEMORY_SCOPE_PROMPT}\n\nUse only after the user explicitly states a stable career fact changed.`; },
      get inputSchema() { return updateBasicInput(); },
      get outputSchema() { return resultSchema(); },
      async call(input) {
        return { data: { result: await runtime.proposalService.proposeBase(runtime.userId, {
          ...input,
          sourceConversationId: runtime.conversationId,
        }) } };
      },
    } satisfies ToolDef<any, any>),
    buildTool({
      ...common,
      name: 'profile_memory_apply',
      searchHint: 'apply an auto-approved profile memory proposal',
      async description() { return 'Apply a proposal only when policy does not require user confirmation.'; },
      async prompt() { return 'If confirmation is required, do not retry; ask the user to accept the proposal.'; },
      get inputSchema() { return applyInput(); },
      get outputSchema() { return resultSchema(); },
      async call(input) {
        return { data: { result: await runtime.proposalService.apply(
          runtime.userId,
          input.proposalId,
          false,
          'agent',
        ) } };
      },
    } satisfies ToolDef<any, any>),
  ];
  return tools;
}

export function createProfileTools(runtime: ProfileToolRuntime): Tool[] {
  return profileFeatureFlags.compactTools()
    ? createCompactProfileTools(runtime)
    : createLegacyProfileTools(runtime);
}
