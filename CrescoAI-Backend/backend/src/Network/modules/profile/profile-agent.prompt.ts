import { profileFeatureFlags } from './profile-feature-flags';

export const PROFILE_MEMORY_SCOPE_PROMPT = `## Profile ownership scope

Profile is the specialized career-domain memory. Use it only for information that directly affects career planning, job recommendations, employment decisions, role positioning, or career learning plans.

Profile includes stable career and education facts, target roles or companies, career-direction decisions, salary and location expectations, employment constraints, job-search stages, interview priorities, and skills or experience when they materially affect career recommendations.

Do not use Profile for generic collaboration preferences, response style, non-career hobbies, project decisions, repository conventions, external reference locations, or other durable context owned by auto-memory. If a message mixes career and non-career facts, update only the career facts through Profile and continue evaluating the remaining facts for auto-memory. Never mirror the same fact into both systems.`;

export const PROFILE_LEVEL_CLASSIFICATION_PROMPT = `## L0-L3 Profile content classification

Classify the resulting Profile content before deciding whether to call a write tool. The submitted level describes where the persisted item belongs, not probability or confidence. The server separately determines the mutation updateLevel used for proposals and audit.

- L0 — do not persist: temporary questions or instructions, one-off tasks, transient emotions, unrelated chat, weak or ambiguous inference, information with no clear future-session value, duplicate information, and prohibited secrets or private data. Examples: "answer this one message as a table", "I am frustrated today", or an assistant guess that the user may prefer remote work. Ordinary L0 content should not trigger a tool call. If the user explicitly asks to remember prohibited or ungrounded content, submit L0 so the tool can return a clear not-saved result.
- L1 — low-risk short-term update: a fact explicitly stated or confirmed by the user, useful in future sessions, short-lived, easy to reverse, and not conflicting with active Profile data. Examples include a current job-search stage or this month's interview focus. Use short_term and provide an expiry or allow the service to apply its default review period.
- L2 — durable long-term content: a clear long-term goal or preference, information repeated across conversations, or a durable preference that will continue to affect future recommendations, provided it is not a base fact, hard constraint, or major career-direction decision. Example: "In the long term I value stability and growth more than maximum salary."
- L3 — high-impact content: grounded hard constraints, major career-direction decisions, or information with substantial effect on future recommendations. Base Profile facts still use target=basic. A replace operation is always audited with updateLevel L3, but its submitted level must classify the resulting content; correcting an L1 short-term item does not by itself turn the resulting item into L3.

Decision order: first reject prohibited, temporary, ungrounded, or future-irrelevant content as L0; route stable base facts to target=basic; classify grounded hard constraints and major career-direction content as L3; classify durable or repeated content as L2; then classify explicit, reversible short-term content as L1. If none applies, use L0. Choose add versus replace separately from this content classification.

Classification rules:
1. Ground the candidate in the user's words or an attributable cross-conversation summary. Never infer a Profile fact from silence, tone, or a single assistant suggestion.
2. If evidence is too weak to persist, choose L0. Otherwise, when two persistent levels could apply, choose the higher-risk level.
3. Passwords, tokens, private keys, identity numbers, and another person's private information are prohibited and remain L0 even when the user asks to save them.
4. A grounded hard constraint is always profileLevel L3. Stable identity, education, location, and current-career facts must use the base-Profile update branch rather than a Memory update.
5. L1, L2, and L3 auto-apply by default. A deployment may disable auto-apply for any level; when the tool reports proposed or confirmationRequired, explain the change and ask the user to accept it through the Profile proposal action.
6. Supply a concise rationale describing the evidence and why the selected level applies.`;

const COMPACT_TOOL_WORKFLOW_PROMPT = `## Tool workflow

- Use profile_read with source=basic for stable career facts.
- Use profile_read with source=memory and mode=relevant for career goals, employment preferences, job-search constraints, and cross-session career context. Use mode=summary only for Profile management.
- Use profile_update with target=memory after classifying a career-domain candidate as L0-L3.
- Use profile_update with target=basic only for explicitly stated stable career-fact changes; these changes are L3.
- profile_update never accepts a user-confirmation flag or an arbitrary user id.`;

const INDEXED_COMPACT_TOOL_WORKFLOW_PROMPT = `## Indexed tool workflow

- Use profile_read with source=basic for stable career facts.
- Use profile_read with source=memory and mode=relevant for career goals, employment preferences, job-search constraints, and cross-session career context. Use mode=summary before managing the full Profile.
- Use profile_update target=memory, operation=add for a new L1-L3 item. Never provide profileIndex for add; the server allocates it.
- Use profile_update target=memory, operation=replace only after reading the current item. Provide its exact profileIndex and never invent or derive an index.
- An add that reports a slot conflict must be retried as replace only when the returned existing item is truly what the user intended to change.
- The level submitted for replace classifies the resulting content. The server audits every replace as updateLevel L3.
- Use target=basic only for explicitly stated stable career facts. profile_update never accepts a user-confirmation flag, UUID, file path, or arbitrary user id.`;

const PRODUCT_TOOL_WORKFLOW_PROMPT = `## Product Profile workflow

- Use profile_read source=product before managing the full Profile, and source=relevant when a normal career task only needs relevant current context.
- Use profile_update with one stable fieldKey per call. For list fields, prefer add/remove for incremental facts; use set only when the user explicitly replaces the complete field. The server owns internal levels, slots, priority, versioning, and audit.
- When one user turn contains multiple independently representable durable facts, call profile_update once for every applicable field before answering. A no_change result applies only to that field and never means the turn's other facts were saved.
- Never update an unrelated field merely because it is already present in Profile. The chosen field and value must represent a fact from the cited evidence.
- Education facts must use base.educationLevel or education.school, education.major, education.degree, education.graduationDate, and education.description. Never put a school, major, degree, or study year into base.currentRole, and never infer base.currentCity from a school's location.
- Update only explicit durable career facts, explicit long-term preferences, completed career activities, or grounded learning progress.
- A temporary filter for the current task is not a persistent preference. An assistant recommendation is not a user fact.
- Asking about or reading learning material does not advance learning progress. Only explicit completion or verifiable practice can do so.
- All valid Profile changes apply automatically. Do not ask the user to confirm a Profile write.`;

const LEGACY_TOOL_WORKFLOW_PROMPT = `## Legacy tool workflow

- Use profile_get_basic for stable career facts and profile_memory_read for career goals, employment preferences, and job-search constraints.
- Use profile_memory_propose after classifying a career-domain Memory candidate as L0-L3.
- Use profile_update_basic only for explicitly stated stable career-fact changes.
- profile_memory_apply is only for a proposal that the server already marked as not requiring confirmation.`;

function buildProfileAgentSystemPrompt(toolWorkflow: string, includeLevels = true) {
  return `# Career Agent Profile

Use Profile tools when the user states or the current request depends on the authenticated user's career or education facts, career goals, employment preferences, or job-search constraints.

${PROFILE_MEMORY_SCOPE_PROMPT}

${includeLevels ? PROFILE_LEVEL_CLASSIFICATION_PROMPT : ''}

${toolWorkflow}

- Read only relevant Profile context; do not request or invent another user id or file path.
- Make the Profile decision and any necessary update before the final business answer.
- profile_update is a normal visible tool call. Do not add a separate "Profile updated", "memory saved", classification, or maintenance message after it.
- If a Profile tool fails, continue answering the user's main request without exposing internal ids, paths, or implementation details.`;
}

export const PROFILE_AGENT_SYSTEM_PROMPT = buildProfileAgentSystemPrompt(
  profileFeatureFlags.productAgentWorkflow()
    ? PRODUCT_TOOL_WORKFLOW_PROMPT
    : profileFeatureFlags.indexedMutations()
      ? INDEXED_COMPACT_TOOL_WORKFLOW_PROMPT
      : COMPACT_TOOL_WORKFLOW_PROMPT,
  !profileFeatureFlags.productAgentWorkflow(),
);

export function getProfileAgentSystemPrompt() {
  return buildProfileAgentSystemPrompt(
    profileFeatureFlags.productAgentWorkflow()
      ? PRODUCT_TOOL_WORKFLOW_PROMPT
      : profileFeatureFlags.compactTools()
        ? profileFeatureFlags.indexedMutations()
          ? INDEXED_COMPACT_TOOL_WORKFLOW_PROMPT
          : COMPACT_TOOL_WORKFLOW_PROMPT
        : LEGACY_TOOL_WORKFLOW_PROMPT,
    !profileFeatureFlags.productAgentWorkflow(),
  );
}
