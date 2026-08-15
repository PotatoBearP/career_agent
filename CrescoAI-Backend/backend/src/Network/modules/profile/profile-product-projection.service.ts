import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { UserEntity } from '../user/entities/user.entity';
import { BaseProfileEntity } from './entities/base-profile.entity';
import { ProfileMemoryItemEntity } from './entities/profile-memory-item.entity';
import { ProfileStateEntity } from './entities/profile-state.entity';
import {
  decodeProfileProductMemoryValue,
  getProfileProductFieldDefinition,
  isKnownProfileProductSlot,
  listProfileProductFieldDefinitions,
  normalizeProfileProductValue,
} from './profile-product-field.registry';
import {
  PROFILE_PRODUCT_SCHEMA_VERSION,
  type CareerProfileProductView,
  type ProfileProductField,
  type ProfileProductFieldKey,
  type ProfileProductValue,
} from './profile-product.types';
import { ProfileV2Service } from './profile-v2.service';
import { normalizeProfileRecord, type ProfileRecord } from './profile.types';
import { ProfileEvidenceService } from './profile-evidence.service';
import type { ProfileEvidenceLinkEntity } from './entities/profile-evidence-link.entity';
import type { ProfileProductListField } from './profile-product.types';
import type { EducationBackgroundItem } from './profile-v2.types';

@Injectable()
export class ProfileProductProjectionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly profileV2Service: ProfileV2Service,
    private readonly evidenceService: ProfileEvidenceService,
  ) {}

  async getProductProfile(userId: number): Promise<CareerProfileProductView> {
    await this.profileV2Service.getState(userId);
    return this.dataSource.transaction(async (manager) => {
      const [user, base, state, memories, evidenceLinks] = await Promise.all([
        manager.findOneOrFail(UserEntity, { where: { id: userId } }),
        manager.findOneOrFail(BaseProfileEntity, { where: { userId } }),
        manager.findOneOrFail(ProfileStateEntity, { where: { userId } }),
        manager.find(ProfileMemoryItemEntity, {
          where: { userId, status: 'active' },
          order: { updatedAt: 'DESC' },
        }),
        this.evidenceService.getActiveLinks(userId),
      ]);
      const legacy = normalizeProfileRecord(
        this.parseLegacyProfile(user.profileJson),
        user.displayName ?? '',
      );
      return this.project(base, state.aggregateVersion, memories, legacy, evidenceLinks);
    });
  }

  private project(
    base: BaseProfileEntity,
    version: number,
    memories: ProfileMemoryItemEntity[],
    legacy: ProfileRecord,
    evidenceLinks: ProfileEvidenceLinkEntity[],
  ): CareerProfileProductView {
    const now = Date.now();
    const visibleMemories = memories.filter((memory) =>
      !memory.expiresAt || memory.expiresAt.getTime() > now);
    const education = this.parseEducation(base.educationBackgroundJson)[0]
      ?? this.emptyEducation();
    const values = new Map<ProfileProductFieldKey, ProfileProductValue>();
    for (const definition of listProfileProductFieldDefinitions()) {
      if (definition.storage === 'base' && definition.baseProperty) {
        values.set(definition.fieldKey, base[definition.baseProperty] as ProfileProductValue);
        continue;
      }
      if (definition.storage === 'education' && definition.educationProperty) {
        values.set(
          definition.fieldKey,
          education[definition.educationProperty] as ProfileProductValue,
        );
        continue;
      }
      const candidate = this.selectMemory(
        definition.slotKey!,
        definition.aliases ?? [],
        visibleMemories,
      );
      values.set(
        definition.fieldKey,
        candidate
          ? decodeProfileProductMemoryValue(definition, candidate.content)
          : normalizeProfileProductValue(
              definition,
              this.legacyFallback(definition.fieldKey, legacy),
            ),
      );
    }

    const relatedConversation = (fieldKey: ProfileProductFieldKey, value?: string) => {
      const valueKey = value === undefined ? undefined : this.evidenceService.valueKey(fieldKey, value);
      const matches = evidenceLinks.filter((link) =>
        link.fieldKey === fieldKey && (valueKey === undefined || link.valueKey === valueKey));
      if (!matches.length) return undefined;
      return { ref: matches[0].publicRef, count: new Set(matches.map((link) => link.conversationId)).size };
    };
    const field = <T extends ProfileProductValue>(fieldKey: ProfileProductFieldKey) => {
      const value = values.get(fieldKey) as T;
      return {
        fieldKey,
        value,
        ...(Array.isArray(value) ? {} : { relatedConversation: relatedConversation(fieldKey) }),
      } satisfies ProfileProductField<T>;
    };
    const listField = (fieldKey: ProfileProductFieldKey): ProfileProductListField => {
      const value = values.get(fieldKey);
      const list = Array.isArray(value) ? value : [];
      return {
        fieldKey,
        value: list,
        items: list.map((item) => ({
          itemKey: this.evidenceService.itemKey(fieldKey, item),
          value: item,
          relatedConversation: relatedConversation(fieldKey, item),
        })),
      };
    };

    return {
      schemaVersion: PROFILE_PRODUCT_SCHEMA_VERSION,
      version,
      header: {
        name: field<string>('base.name'),
        currentRole: field<string>('base.currentRole'),
        currentCity: field<string>('base.currentCity'),
        currentStatus: field<string>('base.currentStatus'),
        currentIndustry: field<string>('base.currentIndustry'),
        yearsOfExperience: field<number | null>('base.yearsOfExperience'),
      },
      education: {
        level: field<string>('base.educationLevel'),
        school: field<string>('education.school'),
        major: field<string>('education.major'),
        degree: field<string>('education.degree'),
        graduationDate: field<string | null>('education.graduationDate'),
        description: field<string>('education.description'),
      },
      summary: field<string>('profile.summary'),
      skills: listField('career.skills'),
      career: {
        workExperience: listField('career.workExperience'),
        projectExperience: listField('career.projectExperience'),
        direction: field<string>('career.direction'),
        searchStatus: field<string>('job.searchStatus'),
      },
      jobIntent: {
        targetRoles: listField('job.targetRoles'),
        targetIndustries: listField('job.targetIndustries'),
        locations: listField('job.locations'),
        workModes: listField('job.workModes'),
        salaryExpectation: field<string>('job.salaryExpectation'),
        exclusions: listField('job.exclusions'),
      },
      learning: {
        goals: listField('learning.goals'),
        activeSkills: listField('learning.activeSkills'),
        milestones: listField('learning.milestones'),
        blockers: listField('learning.blockers'),
        nextFocus: field<string>('learning.nextFocus'),
      },
      additionalHighlights: this.additionalHighlights(visibleMemories),
    };
  }

  private selectMemory(
    canonicalSlot: string,
    aliases: readonly string[],
    memories: ProfileMemoryItemEntity[],
  ) {
    return memories.find((memory) => memory.slotKey === canonicalSlot)
      ?? memories.find((memory) => aliases.includes(memory.slotKey));
  }

  private additionalHighlights(memories: ProfileMemoryItemEntity[]) {
    const seen = new Set<string>();
    const values: string[] = [];
    for (const memory of memories) {
      if (isKnownProfileProductSlot(memory.slotKey)) continue;
      const text = this.humanText(memory.content);
      const key = text.toLocaleLowerCase();
      if (!text || seen.has(key)) continue;
      seen.add(key);
      values.push(text);
    }
    return values.slice(0, 30);
  }

  private humanText(content: string) {
    try {
      const value = JSON.parse(content) as unknown;
      if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === 'string').join('、');
      }
    } catch {
      // Plain text is already a valid product highlight.
    }
    return content.trim();
  }

  private legacyFallback(fieldKey: ProfileProductFieldKey, profile: ProfileRecord) {
    const values: Partial<Record<ProfileProductFieldKey, unknown>> = {
      'profile.summary': profile.artifacts.resumeSummary,
      'career.skills': profile.careerProfile.skills,
      'career.workExperience': profile.careerProfile.workExperience,
      'career.projectExperience': profile.careerProfile.projectExperience,
      'career.direction': profile.intentConstraints.careerGoal,
      'job.targetRoles': profile.intentConstraints.targetRole,
      'job.targetIndustries': profile.intentConstraints.targetIndustries.length
        ? profile.intentConstraints.targetIndustries
        : profile.intentConstraints.targetIndustry,
      'job.locations': profile.intentConstraints.targetCity,
      'job.workModes': profile.intentConstraints.workPreferences,
      'job.salaryExpectation': profile.intentConstraints.expectedSalary,
      'job.exclusions': profile.intentConstraints.constraints,
      'job.searchStatus': profile.intentConstraints.jobSearchStatus,
      'learning.goals': profile.planState.learningPlan,
      'learning.milestones': profile.activityRecords.learningRecords,
    };
    return values[fieldKey];
  }

  private parseLegacyProfile(value: string | null | undefined) {
    if (!value) return {};
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return {};
    }
  }

  private parseEducation(raw: string): EducationBackgroundItem[] {
    try {
      const value = JSON.parse(raw) as unknown;
      return Array.isArray(value) ? value as EducationBackgroundItem[] : [];
    } catch {
      return [];
    }
  }

  private emptyEducation(): EducationBackgroundItem {
    return {
      school: '',
      major: '',
      degree: '',
      graduationDate: null,
      description: '',
    };
  }
}
