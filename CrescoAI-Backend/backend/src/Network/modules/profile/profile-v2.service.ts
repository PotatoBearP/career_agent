import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { UserEntity } from '../user/entities/user.entity';
import { applyPublicAccountPatch } from '../integration/account-publication';
import { UpdateBaseProfileDto } from './dto/base-profile.dto';
import { BaseProfileEntity } from './entities/base-profile.entity';
import { ProfileRevisionEntity } from './entities/profile-revision.entity';
import { ProfileStateEntity } from './entities/profile-state.entity';
import { ProfileProjectionJobEntity } from './entities/profile-projection-job.entity';
import { profileAccessDenied, profileValidationError, profileVersionConflict } from './profile.errors';
import { profileFeatureFlags } from './profile-feature-flags';
import { normalizeProfileRecord } from './profile.types';
import {
  PROFILE_V2_SCHEMA_VERSION,
  type BaseProfilePatch,
  type BaseProfileRecord,
  type EducationBackgroundItem,
  type ProfileMutationMeta,
  type ProfileReadSnapshot,
} from './profile-v2.types';

@Injectable()
export class ProfileV2Service {
  private readonly initializationByUser = new Map<
    number,
    Promise<{ base: BaseProfileEntity; state: ProfileStateEntity }>
  >();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    @InjectRepository(BaseProfileEntity)
    private readonly baseRepo: Repository<BaseProfileEntity>,
    @InjectRepository(ProfileStateEntity)
    private readonly stateRepo: Repository<ProfileStateEntity>,
  ) {}

  async getBaseProfile(userId: number): Promise<BaseProfileRecord> {
    const { base: entity } = await this.ensureProfileInitialized(userId);
    return this.toBaseRecord(entity);
  }

  /**
   * Initializes Profile V2 once and returns the read data that recall and
   * proposal flows need from the same transaction. SQLite uses a single
   * connection, so callers must not compose getBaseProfile() and getState()
   * with Promise.all().
   */
  async getReadSnapshot(userId: number): Promise<ProfileReadSnapshot> {
    const { base, state } = await this.ensureProfileInitialized(userId);
    return {
      base: this.toBaseRecord(base),
      aggregateVersion: state.aggregateVersion,
    };
  }

  async updateBaseProfile(
    userId: number,
    input: UpdateBaseProfileDto | BaseProfilePatch,
    meta: ProfileMutationMeta,
  ): Promise<BaseProfileRecord> {
    if (!profileFeatureFlags.v2Write()) {
      throw profileAccessDenied('Profile V2 writes are disabled');
    }
    if (
      meta.actorType === 'agent'
      && !meta.userConfirmed
      && !profileFeatureFlags.l3AutoApply()
    ) {
      throw profileAccessDenied(
        'Agent cannot update base profile fields while L3 auto-apply is disabled',
      );
    }

    const patch = this.normalizeBasePatch(input);
    if (!Object.keys(patch).length) {
      throw profileValidationError('at least one base profile field is required');
    }

    await this.ensureProfileInitialized(userId);
    return this.dataSource.transaction(async (manager) => {
      const [entity, existingState] = await Promise.all([
        manager.findOneOrFail(BaseProfileEntity, { where: { userId } }),
        manager.findOneOrFail(ProfileStateEntity, { where: { userId } }),
      ]);

      if (
        meta.expectedAggregateVersion !== undefined
        && meta.expectedAggregateVersion !== existingState.aggregateVersion
      ) {
        throw profileVersionConflict(
          meta.expectedAggregateVersion,
          existingState.aggregateVersion,
        );
      }

      const expectedVersion = meta.expectedVersion ?? (input as UpdateBaseProfileDto).expectedVersion;
      if (expectedVersion !== undefined && expectedVersion !== entity.version) {
        throw profileVersionConflict(expectedVersion, entity.version);
      }

      const before = this.toBaseRecord(entity);
      this.applyBasePatch(entity, patch);
      entity.version += 1;
      const saved = await manager.save(entity);

      const state = existingState;
      state.aggregateVersion += 1;
      state.projectionStatus = 'pending';
      await manager.save(state);
      await manager.save(manager.create(ProfileProjectionJobEntity, {
        userId,
        targetVersion: state.aggregateVersion,
        status: 'pending',
        retryCount: 0,
        lastError: null,
      }));

      const after = this.toBaseRecord(saved);
      await manager.save(
        manager.create(ProfileRevisionEntity, {
          userId,
          aggregateVersion: state.aggregateVersion,
          targetType: 'base_profile',
          targetId: String(saved.id),
          operation: 'update',
          beforeJson: JSON.stringify(before),
          afterJson: JSON.stringify(after),
          sourceType: meta.sourceType,
          updateLevel: meta.updateLevel ?? 'L3',
          sourceConversationId: meta.sourceConversationId ?? null,
          sourceMessageId: meta.sourceMessageId ?? null,
          userConfirmed: meta.userConfirmed ?? meta.actorType === 'user',
          actorType: meta.actorType ?? 'user',
        }),
      );

      if (patch.name) {
        const user = await manager.findOne(UserEntity, { where: { id: userId } });
        if (user) {
          await applyPublicAccountPatch(manager, user, {
            displayName: patch.name,
          });
        }
      }

      return after;
    });
  }

  async getState(userId: number) {
    const { state } = await this.ensureProfileInitialized(userId);
    return state;
  }

  private async ensureProfileInitialized(userId: number) {
    const existing = this.initializationByUser.get(userId);
    if (existing) return existing;

    const initialization = this.initializeProfile(userId);
    this.initializationByUser.set(userId, initialization);
    const clear = () => {
      if (this.initializationByUser.get(userId) === initialization) {
        this.initializationByUser.delete(userId);
      }
    };
    initialization.then(clear, clear);
    return initialization;
  }

  private async initializeProfile(userId: number) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.dataSource.transaction(async (manager) => {
          const user = await manager.findOne(UserEntity, {
            where: { id: userId },
          });
          if (!user) {
            throw profileValidationError(
              'authenticated user does not exist',
            );
          }

          let base = await manager.findOne(BaseProfileEntity, {
            where: { userId },
          });
          if (!base) {
            const legacy = normalizeProfileRecord(
              this.parseJson(user.profileJson),
              user.displayName ?? '',
            );
            const education = legacy.careerProfile.educationBackground
              ? [{
                  school: '',
                  major: '',
                  degree: '',
                  graduationDate: null,
                  description: legacy.careerProfile.educationBackground,
                }]
              : [];
            base = await manager.save(manager.create(BaseProfileEntity, {
              userId,
              name:
                legacy.basicInfo.fullName || user.displayName || '',
              gender: '',
              birthDate: null,
              educationLevel: '',
              educationBackgroundJson: JSON.stringify(education),
              currentCity: legacy.basicInfo.currentCity,
              currentStatus: legacy.careerProfile.employmentStatus,
              currentRole: legacy.careerProfile.currentRole,
              currentIndustry: '',
              yearsOfExperience: null,
              contactLanguage: '',
              version: 1,
            }));
          }

          let state = await manager.findOne(ProfileStateEntity, {
            where: { userId },
          });
          if (!state) {
            state = await manager.save(manager.create(ProfileStateEntity, {
              userId,
              aggregateVersion: 1,
              projectionVersion: 0,
              projectionStatus: 'pending',
              nextProfileIndex: 1,
            }));
          }

          const baseTargetId = String(base.id);
          const revision = await manager.findOne(ProfileRevisionEntity, {
            where: {
              userId,
              targetType: 'base_profile',
              targetId: baseTargetId,
            },
            order: { id: 'ASC' },
          });
          if (!revision) {
            await manager.save(manager.create(ProfileRevisionEntity, {
              userId,
              aggregateVersion: state.aggregateVersion,
              targetType: 'base_profile',
              targetId: baseTargetId,
              operation: 'create',
              beforeJson: null,
              afterJson: JSON.stringify(this.toBaseRecord(base)),
              sourceType: 'system_migration',
              updateLevel: 'L3',
              sourceConversationId: null,
              sourceMessageId: null,
              userConfirmed: false,
              actorType: 'system',
            }));
          }

          const projectionJob = await manager.findOne(
            ProfileProjectionJobEntity,
            {
              where: {
                userId,
                targetVersion: state.aggregateVersion,
              },
              order: { id: 'ASC' },
            },
          );
          if (!projectionJob) {
            await manager.save(manager.create(ProfileProjectionJobEntity, {
              userId,
              targetVersion: state.aggregateVersion,
              status: 'pending',
              retryCount: 0,
              lastError: null,
            }));
          }
          return { base, state };
        });
      } catch (error) {
        lastError = error;
        if (!this.isRetryableInitializationError(error) || attempt === 3) {
          throw error;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  private isRetryableInitializationError(error: unknown) {
    const message = error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
    return message.includes('unique constraint')
      || message.includes('sqlite_busy')
      || message.includes('database is locked');
  }

  private normalizeBasePatch(input: UpdateBaseProfileDto | BaseProfilePatch): BaseProfilePatch {
    const patch: BaseProfilePatch = {};
    const textFields = [
      'name',
      'gender',
      'educationLevel',
      'currentCity',
      'currentStatus',
      'currentRole',
      'currentIndustry',
      'contactLanguage',
    ] as const;
    for (const field of textFields) {
      if (input[field] !== undefined) patch[field] = input[field]!.trim();
    }
    if (input.birthDate !== undefined) patch.birthDate = input.birthDate;
    if (input.yearsOfExperience !== undefined) {
      patch.yearsOfExperience = input.yearsOfExperience;
    }
    if (input.educationBackground !== undefined) {
      patch.educationBackground = input.educationBackground.map((item) => ({
        school: item.school.trim(),
        major: item.major.trim(),
        degree: item.degree.trim(),
        graduationDate: item.graduationDate ?? null,
        description: item.description.trim(),
      }));
    }
    return patch;
  }

  private applyBasePatch(entity: BaseProfileEntity, patch: BaseProfilePatch) {
    if (patch.name !== undefined) entity.name = patch.name;
    if (patch.gender !== undefined) entity.gender = patch.gender;
    if (patch.birthDate !== undefined) entity.birthDate = patch.birthDate;
    if (patch.educationLevel !== undefined) entity.educationLevel = patch.educationLevel;
    if (patch.educationBackground !== undefined) {
      entity.educationBackgroundJson = JSON.stringify(patch.educationBackground);
    }
    if (patch.currentCity !== undefined) entity.currentCity = patch.currentCity;
    if (patch.currentStatus !== undefined) entity.currentStatus = patch.currentStatus;
    if (patch.currentRole !== undefined) entity.currentRole = patch.currentRole;
    if (patch.currentIndustry !== undefined) entity.currentIndustry = patch.currentIndustry;
    if (patch.yearsOfExperience !== undefined) {
      entity.yearsOfExperience = patch.yearsOfExperience;
    }
    if (patch.contactLanguage !== undefined) entity.contactLanguage = patch.contactLanguage;
  }

  private toBaseRecord(entity: BaseProfileEntity): BaseProfileRecord {
    const educationBackground = this.parseEducation(entity.educationBackgroundJson);
    const missingRequiredFields = [
      ['name', entity.name],
      ['gender', entity.gender],
      ['birthDate', entity.birthDate],
      ['educationLevel', entity.educationLevel],
      ['educationBackground', educationBackground.length ? 'present' : ''],
      ['currentCity', entity.currentCity],
      ['currentStatus', entity.currentStatus],
    ].filter(([, value]) => !value).map(([key]) => key as string);

    return {
      schemaVersion: PROFILE_V2_SCHEMA_VERSION,
      userId: entity.userId,
      name: entity.name,
      gender: entity.gender,
      birthDate: entity.birthDate,
      age: this.calculateAge(entity.birthDate),
      educationLevel: entity.educationLevel,
      educationBackground,
      currentCity: entity.currentCity,
      currentStatus: entity.currentStatus,
      currentRole: entity.currentRole,
      currentIndustry: entity.currentIndustry,
      yearsOfExperience: entity.yearsOfExperience,
      contactLanguage: entity.contactLanguage,
      version: entity.version,
      missingRequiredFields,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
    };
  }

  private calculateAge(birthDate: string | null) {
    if (!birthDate) return null;
    const birth = new Date(`${birthDate}T00:00:00Z`);
    if (Number.isNaN(birth.getTime())) return null;
    const now = new Date();
    let age = now.getUTCFullYear() - birth.getUTCFullYear();
    const beforeBirthday =
      now.getUTCMonth() < birth.getUTCMonth()
      || (now.getUTCMonth() === birth.getUTCMonth()
        && now.getUTCDate() < birth.getUTCDate());
    if (beforeBirthday) age -= 1;
    return age >= 0 ? age : null;
  }

  private parseEducation(raw: string): EducationBackgroundItem[] {
    try {
      const value = JSON.parse(raw) as unknown;
      return Array.isArray(value) ? value as EducationBackgroundItem[] : [];
    } catch {
      return [];
    }
  }

  private parseJson(raw: string) {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return {};
    }
  }
}
