import { z } from 'zod/v4';
import { buildTool, type Tool, type ToolDef } from '../../../Tool.js';
import { lazySchema } from '../../../utils/lazySchema.js';
import {
  PROFILE_PRODUCT_FIELD_KEYS,
  type CareerProfileProductView,
  type ProfileProductFieldKey,
  type ProfileProductMutationOperation,
  type ProfileProductValue,
} from './profile-product.types';

export type ProfileRefreshStagedMutation = {
  fieldKey: ProfileProductFieldKey;
  operation: ProfileProductMutationOperation;
  value?: ProfileProductValue;
  evidenceRefs: string[];
  rationale: string;
  beforeValue: ProfileProductValue;
};

export function createProfileRefreshTools(input: {
  snapshot: CareerProfileProductView;
  allowedEvidenceRefs: Set<string>;
  staged: ProfileRefreshStagedMutation[];
}): Tool[] {
  const overlay = structuredClone(input.snapshot);
  const resultSchema = lazySchema(() => z.object({ result: z.unknown() }));
  const common = {
    maxResultSizeChars: 40_000,
    strict: true,
    isEnabled: () => true,
    isConcurrencySafe: () => false,
    async checkPermissions(value: Record<string, unknown>) {
      return { behavior: 'allow' as const, updatedInput: value };
    },
    renderToolUseMessage: () => null,
    userFacingName: () => 'Profile',
    mapToolResultToToolResultBlockParam(data: { result: unknown }, toolUseID: string) {
      return { tool_use_id: toolUseID, type: 'tool_result' as const, content: JSON.stringify(data.result) };
    },
  };
  const readInput = lazySchema(() => z.strictObject({ source: z.literal('product') }));
  const updateInput = lazySchema(() => z.strictObject({
    fieldKey: z.enum(PROFILE_PRODUCT_FIELD_KEYS),
    operation: z.enum(['set', 'clear', 'add', 'remove']),
    value: z.union([
      z.string().max(2_000),
      z.array(z.string().max(500)).max(50),
      z.number().min(0).max(80),
      z.null(),
    ]).optional(),
    evidenceRefs: z.array(z.string().regex(/^E\d{4}$/)).min(1).max(8),
    rationale: z.string().min(1).max(1_000),
  }));

  return [
    buildTool({
      ...common,
      name: 'profile_read',
      schemaCacheNamespace: 'product-profile-refresh',
      isReadOnly: () => true,
      searchHint: 'read the staged Profile refresh snapshot',
      async description() { return 'Read the current Profile snapshot including mutations staged in this refresh job.'; },
      async prompt() { return 'Call this first. Internal source ids and storage details are intentionally unavailable.'; },
      get inputSchema() { return readInput(); },
      get outputSchema() { return resultSchema(); },
      async call() { return { data: { result: { source: 'product', data: overlay } } }; },
    } satisfies ToolDef<any, any>),
    buildTool({
      ...common,
      name: 'profile_update',
      schemaCacheNamespace: 'product-profile-refresh',
      searchHint: 'stage one evidence-grounded Profile refresh mutation',
      async description() { return 'Stage one Profile field add, set, clear, remove, or same-value verification with job-local evidence references.'; },
      async prompt() { return 'Use only E-number references from the supplied catalog. One field per call. Same value plus evidenceRefs is a verification. Prefer list add/remove over set. Save education facts with base.educationLevel or education.school, education.major, education.degree, education.graduationDate, and education.description; never put school, major, degree, or study year in base.currentRole or infer base.currentCity from a school location.'; },
      get inputSchema() { return updateInput(); },
      get outputSchema() { return resultSchema(); },
      async call(value) {
        if (!value.evidenceRefs.every((ref: string) => input.allowedEvidenceRefs.has(ref))) {
          throw new Error('Unknown or out-of-job evidence reference');
        }
        const beforeValue = structuredClone(findField(overlay, value.fieldKey)?.value ?? null);
        const staged: ProfileRefreshStagedMutation = {
          fieldKey: value.fieldKey,
          operation: value.operation,
          value: value.value,
          evidenceRefs: [...new Set(value.evidenceRefs as string[])],
          rationale: value.rationale,
          beforeValue,
        };
        input.staged.push(staged);
        applyOverlay(overlay, staged);
        return { data: { result: {
          target: 'product_profile',
          field: value.fieldKey,
          outcome: 'staged',
          stagedCount: input.staged.length,
        } } };
      },
    } satisfies ToolDef<any, any>),
  ];
}

function applyOverlay(view: CareerProfileProductView, mutation: ProfileRefreshStagedMutation) {
  const field = findField(view, mutation.fieldKey);
  if (!field) return;
  if (mutation.operation === 'clear') {
    field.value = Array.isArray(field.value) ? [] : typeof field.value === 'number' ? null : '';
    return;
  }
  if (mutation.operation === 'set') {
    field.value = structuredClone(mutation.value ?? '') as any;
    return;
  }
  const current = Array.isArray(field.value) ? field.value : [];
  const delta = Array.isArray(mutation.value)
    ? mutation.value
    : typeof mutation.value === 'string' ? [mutation.value] : [];
  if (mutation.operation === 'add') {
    field.value = [...new Set([...current, ...delta])] as any;
  } else {
    const removed = new Set(delta.map((item) => item.normalize('NFKC').toLocaleLowerCase()));
    field.value = current.filter((item) => !removed.has(item.normalize('NFKC').toLocaleLowerCase())) as any;
  }
}

function findField(value: unknown, fieldKey: ProfileProductFieldKey): { value: ProfileProductValue } | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.fieldKey === fieldKey && 'value' in candidate) return candidate as any;
  for (const child of Object.values(candidate)) {
    const match = findField(child, fieldKey);
    if (match) return match;
  }
  return null;
}
