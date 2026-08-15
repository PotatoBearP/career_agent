import { Injectable } from '@nestjs/common';
import { profileFeatureFlags } from './profile-feature-flags';
import { ProfileMemoryService } from './profile-memory.service';
import { ProfileV2Service } from './profile-v2.service';
import type { ProfileContextRecord, ProfileMemoryRecord } from './profile-v2.types';

const intentRules: Array<[string, RegExp]> = [
  ['job_recommendation', /岗位|职位|工作机会|推荐.*(?:工作|岗位)|job|position/i],
  ['resume_editing', /简历|求职信|项目经历|resume|cv/i],
  ['career_planning', /职业规划|发展方向|长期目标|转行|career path/i],
  ['interview', /面试|mock interview|interview/i],
  ['learning', /学习|课程|提升|补齐|学习计划|study|learn/i],
];

const intentTags: Record<string, string[]> = {
  job_recommendation: ['job', 'recommendation', 'location', 'compensation', 'work'],
  resume_editing: ['resume', 'expression', 'target_role', 'project'],
  career_planning: ['career', 'goal', 'value', 'decision'],
  interview: ['interview', 'target_role', 'communication'],
  learning: ['learning', 'skill', 'target_role'],
  general: ['general'],
};

@Injectable()
export class ProfileRecallService {
  constructor(
    private readonly baseService: ProfileV2Service,
    private readonly memoryService: ProfileMemoryService,
  ) {}

  async buildContext(userId: number, query: string): Promise<ProfileContextRecord | null> {
    if (!profileFeatureFlags.recall()) return null;
    // getBaseProfile() and getState() both initialize Profile V2 transactionally.
    // Running them concurrently produces nested BEGIN statements on SQLite's
    // single connection. Read both values from one initialization snapshot.
    const snapshot = await this.baseService.getReadSnapshot(userId);
    const memories = await this.memoryService.list(userId, {
      status: 'active',
      limit: 200,
    });
    const base = snapshot.base;
    const intent = this.classifyIntent(query);
    const now = Date.now();
    const effective = memories.filter((item) =>
      !item.expiresAt || new Date(item.expiresAt).getTime() > now);
    const scored = effective
      .map((item) => ({ item, score: this.score(item, query, intent) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score);
    const hardConstraints = scored
      .filter(({ item }) => item.priority === 'hard_constraint')
      .slice(0, 8)
      .map(({ item }) => item);
    const selectedIds = new Set(hardConstraints.map((item) => item.id));
    const selected = scored
      .filter(({ item }) => !selectedIds.has(item.id))
      .slice(0, 12)
      .map(({ item }) => item);
    const shortTerm = selected.filter((item) => item.timeScope === 'short_term');
    const longTerm = selected.filter((item) => item.timeScope === 'long_term');
    const baseFacts = this.selectBaseFacts(base, intent);
    const rendered = this.render({
      intent,
      baseFacts,
      hardConstraints,
      shortTerm,
      longTerm,
    }).slice(0, 8_000);
    return {
      version: snapshot.aggregateVersion,
      queryIntent: intent,
      baseFacts,
      hardConstraints,
      shortTerm,
      longTerm,
      rendered,
    };
  }

  private classifyIntent(query: string) {
    return intentRules.find(([, pattern]) => pattern.test(query))?.[0] ?? 'general';
  }

  private score(item: ProfileMemoryRecord, query: string, intent: string) {
    const tags = intentTags[intent] ?? intentTags.general;
    const searchable = [item.content, item.category, item.slotKey, ...item.appliesTo]
      .join(' ')
      .toLowerCase();
    const queryTokens = this.tokens(query);
    let score = 0;
    const appliesToIntent = !item.appliesTo.length
      || item.appliesTo.some((tag) => tags.includes(tag));
    if (item.priority === 'hard_constraint' && appliesToIntent) {
      score += intent === 'general' ? 15 : 100;
    }
    if (item.timeScope === 'short_term') score += 35;
    if (item.priority === 'high') score += 25;
    if (item.priority === 'normal') score += 10;
    score += tags.filter((tag) => searchable.includes(tag.toLowerCase())).length * 20;
    score += queryTokens.filter((token) => searchable.includes(token)).length * 12;
    if (!appliesToIntent) {
      score -= 50;
    }
    return score;
  }

  private tokens(query: string) {
    return [...new Set(
      query.toLowerCase().match(/[\p{Script=Han}]{2,}|[a-z0-9_]{3,}/gu) ?? [],
    )].slice(0, 30);
  }

  private selectBaseFacts(
    base: Awaited<ReturnType<ProfileV2Service['getBaseProfile']>>,
    intent: string,
  ) {
    const entries: Array<[string, string | number | null]> = [
      ['name', base.name],
      ['currentStatus', base.currentStatus],
      ['currentRole', base.currentRole],
      ['currentIndustry', base.currentIndustry],
      ['currentCity', base.currentCity],
      ['educationLevel', base.educationLevel],
      ['educationSchool', base.educationBackground[0]?.school ?? ''],
      ['educationMajor', base.educationBackground[0]?.major ?? ''],
      ['educationDegree', base.educationBackground[0]?.degree ?? ''],
      ['educationGraduationDate', base.educationBackground[0]?.graduationDate ?? null],
      ['yearsOfExperience', base.yearsOfExperience],
      ['contactLanguage', base.contactLanguage],
    ];
    const allowed = intent === 'resume_editing'
      ? new Set(['name', 'currentStatus', 'currentRole', 'currentIndustry', 'currentCity', 'educationLevel', 'educationSchool', 'educationMajor', 'educationDegree', 'educationGraduationDate', 'yearsOfExperience'])
      : intent === 'job_recommendation'
        ? new Set(['currentStatus', 'currentRole', 'currentIndustry', 'currentCity', 'educationLevel', 'educationSchool', 'educationMajor', 'educationDegree', 'educationGraduationDate', 'yearsOfExperience'])
        : new Set(['currentStatus', 'currentRole', 'currentIndustry', 'educationLevel', 'educationSchool', 'educationMajor', 'educationDegree']);
    return entries
      .filter(([key, value]) => allowed.has(key) && value !== '' && value !== null)
      .map(([key, value]) => ({ key, value: String(value) }));
  }

  private render(input: {
    intent: string;
    baseFacts: Array<{ key: string; value: string }>;
    hardConstraints: ProfileMemoryRecord[];
    shortTerm: ProfileMemoryRecord[];
    longTerm: ProfileMemoryRecord[];
  }) {
    const lines = [
      '# Current authenticated user Profile Context',
      `Query intent: ${input.intent}`,
      'Use only information relevant to the current request. Active hard constraints must not be violated.',
    ];
    if (input.hardConstraints.length) {
      lines.push('## Hard constraints', ...input.hardConstraints.map((item) => `- [${item.profileIndex}][${item.profileLevel}] ${item.content}`));
    }
    if (input.shortTerm.length) {
      lines.push('## Relevant short-term Profile', ...input.shortTerm.map((item) => `- [${item.profileIndex}][${item.profileLevel}] ${item.content}`));
    }
    if (input.longTerm.length) {
      lines.push('## Relevant long-term Profile', ...input.longTerm.map((item) => `- [${item.profileIndex}][${item.profileLevel}] ${item.content}`));
    }
    if (input.baseFacts.length) {
      lines.push('## Necessary base facts', ...input.baseFacts.map((item) => `- ${item.key}: ${item.value}`));
    }
    lines.push('When an important Profile item changes the recommendation, explain the relevant user preference or constraint in user-facing language.');
    return lines.join('\n');
  }
}
