import type {
  ProfileProductFieldKey,
  ProfileProductValue,
} from './profile-product.types';

export type ProfileProductCodec = 'text' | 'string_list' | 'line_list' | 'number' | 'date';

export interface ProfileProductFieldDefinition {
  fieldKey: ProfileProductFieldKey;
  storage: 'base' | 'education' | 'memory';
  codec: ProfileProductCodec;
  baseProperty?:
    | 'name'
    | 'currentRole'
    | 'currentCity'
    | 'currentStatus'
    | 'currentIndustry'
    | 'yearsOfExperience'
    | 'educationLevel';
  educationProperty?:
    | 'school'
    | 'major'
    | 'degree'
    | 'graduationDate'
    | 'description';
  slotKey?: string;
  aliases?: readonly string[];
  category: string;
  appliesTo: readonly string[];
  timeScope: 'long_term' | 'short_term';
  priority: 'hard_constraint' | 'high' | 'normal' | 'background';
  internalLevel: 'L1' | 'L2' | 'L3';
}

const definitions: ProfileProductFieldDefinition[] = [
  { fieldKey: 'base.name', storage: 'base', codec: 'text', baseProperty: 'name', category: 'identity', appliesTo: ['profile'], timeScope: 'long_term', priority: 'normal', internalLevel: 'L3' },
  { fieldKey: 'base.currentRole', storage: 'base', codec: 'text', baseProperty: 'currentRole', category: 'career', appliesTo: ['career', 'job', 'resume'], timeScope: 'long_term', priority: 'high', internalLevel: 'L3' },
  { fieldKey: 'base.currentCity', storage: 'base', codec: 'text', baseProperty: 'currentCity', category: 'location', appliesTo: ['career', 'job'], timeScope: 'long_term', priority: 'high', internalLevel: 'L3' },
  { fieldKey: 'base.currentStatus', storage: 'base', codec: 'text', baseProperty: 'currentStatus', category: 'career', appliesTo: ['career', 'job'], timeScope: 'short_term', priority: 'normal', internalLevel: 'L3' },
  { fieldKey: 'base.currentIndustry', storage: 'base', codec: 'text', baseProperty: 'currentIndustry', category: 'career', appliesTo: ['career', 'job'], timeScope: 'long_term', priority: 'normal', internalLevel: 'L3' },
  { fieldKey: 'base.yearsOfExperience', storage: 'base', codec: 'number', baseProperty: 'yearsOfExperience', category: 'career', appliesTo: ['career', 'job', 'resume'], timeScope: 'long_term', priority: 'normal', internalLevel: 'L3' },
  { fieldKey: 'base.educationLevel', storage: 'base', codec: 'text', baseProperty: 'educationLevel', category: 'education', appliesTo: ['profile', 'career', 'job', 'resume'], timeScope: 'long_term', priority: 'normal', internalLevel: 'L3' },
  { fieldKey: 'education.school', storage: 'education', codec: 'text', educationProperty: 'school', category: 'education', appliesTo: ['profile', 'career', 'job', 'resume'], timeScope: 'long_term', priority: 'high', internalLevel: 'L3' },
  { fieldKey: 'education.major', storage: 'education', codec: 'text', educationProperty: 'major', category: 'education', appliesTo: ['profile', 'career', 'job', 'resume', 'learning'], timeScope: 'long_term', priority: 'high', internalLevel: 'L3' },
  { fieldKey: 'education.degree', storage: 'education', codec: 'text', educationProperty: 'degree', category: 'education', appliesTo: ['profile', 'career', 'job', 'resume'], timeScope: 'long_term', priority: 'normal', internalLevel: 'L3' },
  { fieldKey: 'education.graduationDate', storage: 'education', codec: 'date', educationProperty: 'graduationDate', category: 'education', appliesTo: ['profile', 'career', 'job', 'resume'], timeScope: 'long_term', priority: 'normal', internalLevel: 'L3' },
  { fieldKey: 'education.description', storage: 'education', codec: 'text', educationProperty: 'description', category: 'education', appliesTo: ['profile', 'career', 'job', 'resume', 'learning'], timeScope: 'long_term', priority: 'normal', internalLevel: 'L3' },
  { fieldKey: 'profile.summary', storage: 'memory', codec: 'text', slotKey: 'profile.summary', aliases: ['legacy.artifacts.resumeSummary'], category: 'summary', appliesTo: ['profile', 'career', 'resume'], timeScope: 'long_term', priority: 'normal', internalLevel: 'L2' },
  { fieldKey: 'career.skills', storage: 'memory', codec: 'string_list', slotKey: 'career.skills', aliases: ['legacy.careerProfile.skills'], category: 'skill', appliesTo: ['career', 'job', 'resume', 'learning'], timeScope: 'long_term', priority: 'high', internalLevel: 'L2' },
  { fieldKey: 'career.workExperience', storage: 'memory', codec: 'line_list', slotKey: 'career.work_experience', aliases: ['legacy.careerProfile.workExperience'], category: 'experience', appliesTo: ['career', 'job', 'resume', 'interview'], timeScope: 'long_term', priority: 'high', internalLevel: 'L2' },
  { fieldKey: 'career.projectExperience', storage: 'memory', codec: 'line_list', slotKey: 'career.project_experience', aliases: ['legacy.careerProfile.projectExperience'], category: 'project', appliesTo: ['career', 'job', 'resume', 'interview'], timeScope: 'long_term', priority: 'normal', internalLevel: 'L2' },
  { fieldKey: 'career.direction', storage: 'memory', codec: 'text', slotKey: 'career.direction', aliases: ['legacy.intentConstraints.careerGoal'], category: 'goal', appliesTo: ['career', 'job', 'learning'], timeScope: 'long_term', priority: 'high', internalLevel: 'L3' },
  { fieldKey: 'job.targetRoles', storage: 'memory', codec: 'string_list', slotKey: 'job.target_roles', aliases: ['career.target_role', 'legacy.intentConstraints.targetRole'], category: 'goal', appliesTo: ['career', 'job'], timeScope: 'long_term', priority: 'high', internalLevel: 'L3' },
  { fieldKey: 'job.targetIndustries', storage: 'memory', codec: 'string_list', slotKey: 'job.target_industries', aliases: ['career.target_industry', 'legacy.intentConstraints.targetIndustry', 'legacy.intentConstraints.targetIndustries'], category: 'goal', appliesTo: ['career', 'job'], timeScope: 'long_term', priority: 'normal', internalLevel: 'L2' },
  { fieldKey: 'job.locations', storage: 'memory', codec: 'string_list', slotKey: 'job.locations', aliases: ['work.location', 'legacy.intentConstraints.targetCity'], category: 'preference', appliesTo: ['career', 'job'], timeScope: 'long_term', priority: 'high', internalLevel: 'L3' },
  { fieldKey: 'job.workModes', storage: 'memory', codec: 'string_list', slotKey: 'job.work_modes', aliases: ['legacy.intentConstraints.workPreferences'], category: 'preference', appliesTo: ['career', 'job'], timeScope: 'long_term', priority: 'normal', internalLevel: 'L2' },
  { fieldKey: 'job.salaryExpectation', storage: 'memory', codec: 'text', slotKey: 'job.salary_expectation', aliases: ['work.compensation', 'legacy.intentConstraints.expectedSalary'], category: 'compensation', appliesTo: ['career', 'job'], timeScope: 'long_term', priority: 'high', internalLevel: 'L3' },
  { fieldKey: 'job.exclusions', storage: 'memory', codec: 'string_list', slotKey: 'job.exclusions', aliases: ['legacy.intentConstraints.constraints'], category: 'constraint', appliesTo: ['career', 'job'], timeScope: 'long_term', priority: 'hard_constraint', internalLevel: 'L3' },
  { fieldKey: 'job.searchStatus', storage: 'memory', codec: 'text', slotKey: 'job.search_status', aliases: ['legacy.intentConstraints.jobSearchStatus'], category: 'status', appliesTo: ['career', 'job'], timeScope: 'short_term', priority: 'normal', internalLevel: 'L1' },
  { fieldKey: 'learning.goals', storage: 'memory', codec: 'line_list', slotKey: 'learning.goals', aliases: ['legacy.planState.learningPlan'], category: 'learning', appliesTo: ['career', 'learning'], timeScope: 'long_term', priority: 'normal', internalLevel: 'L2' },
  { fieldKey: 'learning.activeSkills', storage: 'memory', codec: 'string_list', slotKey: 'learning.active_skills', category: 'learning', appliesTo: ['career', 'learning'], timeScope: 'short_term', priority: 'normal', internalLevel: 'L1' },
  { fieldKey: 'learning.milestones', storage: 'memory', codec: 'line_list', slotKey: 'learning.milestones', aliases: ['legacy.activityRecords.learningRecords'], category: 'learning', appliesTo: ['career', 'learning'], timeScope: 'long_term', priority: 'normal', internalLevel: 'L2' },
  { fieldKey: 'learning.blockers', storage: 'memory', codec: 'string_list', slotKey: 'learning.blockers', category: 'learning', appliesTo: ['career', 'learning'], timeScope: 'short_term', priority: 'normal', internalLevel: 'L1' },
  { fieldKey: 'learning.nextFocus', storage: 'memory', codec: 'text', slotKey: 'learning.next_focus', category: 'learning', appliesTo: ['career', 'learning'], timeScope: 'short_term', priority: 'normal', internalLevel: 'L1' },
];

const byKey = new Map(definitions.map((definition) => [definition.fieldKey, definition]));
const knownSlots = new Set(
  definitions.flatMap((definition) => [definition.slotKey, ...(definition.aliases ?? [])])
    .filter((slot): slot is string => Boolean(slot)),
);

export function getProfileProductFieldDefinition(fieldKey: string) {
  return byKey.get(fieldKey as ProfileProductFieldKey);
}

export function listProfileProductFieldDefinitions() {
  return definitions;
}

export function isKnownProfileProductSlot(slotKey: string) {
  return knownSlots.has(slotKey);
}

export function normalizeProfileProductValue(
  definition: ProfileProductFieldDefinition,
  value: unknown,
): ProfileProductValue {
  if (definition.codec === 'date') {
    if (value === null || value === '' || value === undefined) return null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
      throw new Error(`${definition.fieldKey} must use YYYY-MM-DD`);
    }
    const normalized = value.trim();
    const parsed = new Date(`${normalized}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
      throw new Error(`${definition.fieldKey} must be a valid date`);
    }
    return normalized;
  }

  if (definition.codec === 'number') {
    if (value === null || value === '' || value === undefined) return null;
    const numberValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numberValue) || numberValue < 0 || numberValue > 80) {
      throw new Error(`${definition.fieldKey} must be a number between 0 and 80`);
    }
    return Math.round(numberValue * 10) / 10;
  }

  if (isListProfileProductCodec(definition.codec)) {
    const values = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value.split(definition.codec === 'line_list' ? /\n+/ : /[，,\n]/)
        : [];
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const item of values) {
      if (typeof item !== 'string') continue;
      const text = item.replace(/\s+/g, ' ').trim();
      const key = text.toLocaleLowerCase();
      if (!text || seen.has(key)) continue;
      seen.add(key);
      normalized.push(text);
    }
    return normalized.slice(0, 50);
  }

  return typeof value === 'string'
    ? value.replace(/[ \t]+/g, ' ').trim().slice(0, 2_000)
    : '';
}

export function encodeProfileProductMemoryValue(
  definition: ProfileProductFieldDefinition,
  value: ProfileProductValue,
) {
  return isListProfileProductCodec(definition.codec)
    ? JSON.stringify(value)
    : String(value ?? '');
}

export function decodeProfileProductMemoryValue(
  definition: ProfileProductFieldDefinition,
  content: string | null | undefined,
): ProfileProductValue {
  if (!isListProfileProductCodec(definition.codec)) return content?.trim() ?? '';
  if (!content?.trim()) return [];
  try {
    const parsed = JSON.parse(content) as unknown;
    return normalizeProfileProductValue(definition, parsed);
  } catch {
    return normalizeProfileProductValue(definition, content);
  }
}

export function isListProfileProductCodec(codec: ProfileProductCodec) {
  return codec === 'string_list' || codec === 'line_list';
}
