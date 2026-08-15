import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource, EntityManager } from 'typeorm';
import { BaseProfileEntity } from '../src/Network/modules/profile/entities/base-profile.entity.js';
import { ProfileMemoryItemEntity } from '../src/Network/modules/profile/entities/profile-memory-item.entity.js';
import { ProfileProjectionJobEntity } from '../src/Network/modules/profile/entities/profile-projection-job.entity.js';
import { ProfileRevisionEntity } from '../src/Network/modules/profile/entities/profile-revision.entity.js';
import { ProfileStateEntity } from '../src/Network/modules/profile/entities/profile-state.entity.js';
import { ProfileSuggestionEntity } from '../src/Network/modules/profile/entities/profile-suggestion.entity.js';
import { ProfileExternalSnapshotService } from '../src/Network/modules/profile/profile-external-snapshot.service.js';
import { ProfileLegacyAdapterService } from '../src/Network/modules/profile/profile-legacy-adapter.service.js';
import { ProfileMemoryService } from '../src/Network/modules/profile/profile-memory.service.js';
import type { ProfileEvidenceService } from '../src/Network/modules/profile/profile-evidence.service.js';
import { ProfileProductMutationService } from '../src/Network/modules/profile/profile-product-mutation.service.js';
import { ProfileProductProjectionService } from '../src/Network/modules/profile/profile-product-projection.service.js';
import { ProfileRecallService } from '../src/Network/modules/profile/profile-recall.service.js';
import { createProfileRefreshTools } from '../src/Network/modules/profile/profile-refresh.tools.js';
import { createProductProfileTools } from '../src/Network/modules/profile/profile.tools.js';
import type { ProfileProjectionService } from '../src/Network/modules/profile/profile-projection.service.js';
import { createDefaultProfile } from '../src/Network/modules/profile/profile.types.js';
import { ProfileV2Service } from '../src/Network/modules/profile/profile-v2.service.js';
import type { ProfileMemoryRecord } from '../src/Network/modules/profile/profile-v2.types.js';
import { UserEntity } from '../src/Network/modules/user/entities/user.entity.js';

const entities = [
  UserEntity,
  BaseProfileEntity,
  ProfileStateEntity,
  ProfileMemoryItemEntity,
  ProfileRevisionEntity,
  ProfileProjectionJobEntity,
  ProfileSuggestionEntity,
];
const dataSources: DataSource[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const dataSource of [...dataSources].reverse()) {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
  dataSources.length = 0;
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function projectionRecord(entity: ProfileMemoryItemEntity): ProfileMemoryRecord {
  return {
    id: entity.id,
    profileIndex: entity.profileIndex!,
    profileLevel: entity.profileLevel,
    itemVersion: entity.itemVersion,
    content: entity.content,
    category: entity.category,
    slotKey: entity.slotKey,
    appliesTo: JSON.parse(entity.appliesToJson) as string[],
    timeScope: entity.timeScope,
    priority: entity.priority,
    sourceType: entity.sourceType,
    sourceConversationId: entity.sourceConversationId,
    sourceMessageId: entity.sourceMessageId,
    status: entity.status,
    expiresAt: entity.expiresAt?.toISOString() ?? null,
    supersedesId: entity.supersedesId,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
  };
}

function projectionStub() {
  return {
    projectUser: async () => ({ status: 'current', version: 2 }),
    toRecord: projectionRecord,
  } as unknown as ProfileProjectionService;
}

function profileV2Service(
  dataSource: DataSource,
  transactionDataSource: DataSource = dataSource,
) {
  return new ProfileV2Service(
    transactionDataSource,
    dataSource.getRepository(UserEntity),
    dataSource.getRepository(BaseProfileEntity),
    dataSource.getRepository(ProfileStateEntity),
  );
}

function productProjectionService(
  dataSource: DataSource,
  profileV2: ProfileV2Service,
) {
  const evidence = {
    getActiveLinks: async () => [],
    valueKey: () => null,
    itemKey: (_fieldKey: string, value: string) => `item-${value}`,
  } as unknown as ProfileEvidenceService;
  return new ProfileProductProjectionService(dataSource, profileV2, evidence);
}

async function createUser(dataSource: DataSource, displayName = 'Before') {
  const userRepo = dataSource.getRepository(UserEntity);
  return userRepo.save(userRepo.create({
    publicUserId: randomUUID(),
    displayName,
    profileJson: JSON.stringify(createDefaultProfile(displayName)),
    tokenVersion: 0,
    accountStatus: 'active',
    accountVersion: 1,
  }));
}

async function createTestDataSource() {
  const directory = await mkdtemp(join(tmpdir(), 'profile-v2-test-'));
  temporaryDirectories.push(directory);
  const dataSource = new DataSource({
    type: 'sqlite',
    database: join(directory, 'profile.sqlite'),
    synchronize: true,
    entities,
  });
  dataSources.push(dataSource);
  await dataSource.initialize();
  return dataSource;
}

describe('Profile V2 snapshot integration', () => {
  test('legacy write indexes can be replaced through the Profile V2 API', async () => {
    const dataSource = await createTestDataSource();
    const user = await createUser(dataSource);
    const profileV2 = profileV2Service(dataSource);
    const projection = projectionStub();
    const adapter = new ProfileLegacyAdapterService(
      dataSource,
      profileV2,
      projection,
    );
    const snapshotService = new ProfileExternalSnapshotService(
      dataSource,
      profileV2,
    );
    const memoryService = new ProfileMemoryService(
      dataSource,
      dataSource.getRepository(ProfileMemoryItemEntity),
      dataSource.getRepository(ProfileStateEntity),
      dataSource.getRepository(ProfileRevisionEntity),
      projection,
      profileV2,
    );
    const profile = createDefaultProfile('After');
    profile.basicInfo.currentCity = 'Shanghai';
    profile.careerProfile.currentRole = 'Product Manager';
    profile.intentConstraints.targetRole = 'AI Product Manager';
    profile.careerProfile.skills = ['Product strategy', 'AI'];

    await adapter.apply(user.id, profile);
    const updatedUser = await dataSource.getRepository(UserEntity)
      .findOneByOrFail({ id: user.id });
    expect(updatedUser.displayName).toBe('After');
    expect(updatedUser.accountVersion).toBe(2);
    const snapshot = await snapshotService.getCurrentSnapshot(user.id);
    const targetRole = snapshot.profile.memories.find(
      ({ slotKey }) =>
        slotKey === 'legacy.intentConstraints.targetRole',
    );

    expect(targetRole?.profileIndex).toMatch(/^P\d{6,}$/);
    const replaced = await memoryService.replaceByIndex(
      user.id,
      targetRole!.profileIndex,
      {
        content: 'Senior AI Product Manager',
        profileLevel: 'L3',
        expectedVersion: Number(snapshot.profileVersion),
      },
      {
        sourceType: 'user_ui',
        actorType: 'user',
        userConfirmed: true,
        updateLevel: 'L3',
      },
    );
    expect(replaced).toMatchObject({
      profileIndex: targetRole!.profileIndex,
      content: 'Senior AI Product Manager',
    });
  });

  test('Profile V2 name changes advance the public account version once', async () => {
    const dataSource = await createTestDataSource();
    const user = await createUser(dataSource);
    const service = profileV2Service(dataSource);
    await service.getBaseProfile(user.id);

    await service.updateBaseProfile(
      user.id,
      { name: 'Profile V2 Name' },
      {
        sourceType: 'user_ui',
        actorType: 'user',
        userConfirmed: true,
      },
    );

    const updated = await dataSource.getRepository(UserEntity)
      .findOneByOrFail({ id: user.id });
    expect(updated.displayName).toBe('Profile V2 Name');
    expect(updated.accountVersion).toBe(2);
  });

  test('a failed initial revision rolls back and the next request recovers', async () => {
    const dataSource = await createTestDataSource();
    const user = await createUser(dataSource, 'Recoverable');
    let failRevision = true;
    const failingDataSource = {
      transaction: async (
        callback: (manager: EntityManager) => unknown,
      ) => dataSource.transaction(async (manager) => {
        const proxy = new Proxy(manager, {
          get(target, property) {
            if (property === 'save') {
              return async (value: unknown) => {
                if (
                  failRevision
                  && value instanceof ProfileRevisionEntity
                ) {
                  failRevision = false;
                  throw new Error('injected revision failure');
                }
                return target.save(value as never);
              };
            }
            const value = Reflect.get(target, property);
            return typeof value === 'function'
              ? value.bind(target)
              : value;
          },
        });
        return callback(proxy);
      }),
    } as unknown as DataSource;
    const service = profileV2Service(dataSource, failingDataSource);

    await expect(service.getState(user.id))
      .rejects.toThrow('injected revision failure');
    expect(await dataSource.getRepository(BaseProfileEntity).countBy({
      userId: user.id,
    })).toBe(0);
    expect(await dataSource.getRepository(ProfileStateEntity).countBy({
      userId: user.id,
    })).toBe(0);

    await expect(service.getState(user.id)).resolves.toMatchObject({
      aggregateVersion: 1,
    });
    expect(await dataSource.getRepository(ProfileRevisionEntity).countBy({
      userId: user.id,
    })).toBe(1);
    expect(await dataSource.getRepository(ProfileProjectionJobEntity).countBy({
      userId: user.id,
    })).toBe(1);
  });

  test('repairs an existing partial initialization', async () => {
    const dataSource = await createTestDataSource();
    const user = await createUser(dataSource, 'Partial');
    await dataSource.getRepository(BaseProfileEntity).save({
      userId: user.id,
      name: 'Partial',
      gender: '',
      birthDate: null,
      educationLevel: '',
      educationBackgroundJson: '[]',
      currentCity: '',
      currentStatus: '',
      currentRole: '',
      currentIndustry: '',
      yearsOfExperience: null,
      contactLanguage: '',
      version: 1,
    });
    await dataSource.getRepository(ProfileStateEntity).save({
      userId: user.id,
      aggregateVersion: 1,
      projectionVersion: 0,
      projectionStatus: 'pending',
      nextProfileIndex: 1,
    });

    await profileV2Service(dataSource).getState(user.id);

    expect(await dataSource.getRepository(ProfileRevisionEntity).countBy({
      userId: user.id,
    })).toBe(1);
    expect(await dataSource.getRepository(ProfileProjectionJobEntity).countBy({
      userId: user.id,
    })).toBe(1);
  });

  test('concurrent base and state reads share one SQLite initialization transaction', async () => {
    const dataSource = await createTestDataSource();
    const user = await createUser(dataSource, 'Concurrent reads');
    const service = profileV2Service(dataSource);

    const [base, state] = await Promise.all([
      service.getBaseProfile(user.id),
      service.getState(user.id),
    ]);

    expect(base).toMatchObject({
      userId: user.id,
      name: 'Concurrent reads',
      version: 1,
    });
    expect(state).toMatchObject({
      userId: user.id,
      aggregateVersion: 1,
    });
    expect(await dataSource.getRepository(ProfileRevisionEntity).countBy({
      userId: user.id,
    })).toBe(1);
    expect(await dataSource.getRepository(ProfileProjectionJobEntity).countBy({
      userId: user.id,
    })).toBe(1);
  });

  test('Profile recall does not open nested SQLite initialization transactions', async () => {
    const dataSource = await createTestDataSource();
    const user = await createUser(dataSource, 'Recall user');
    const service = profileV2Service(dataSource);
    const recall = new ProfileRecallService(service, {
      list: async () => [],
    } as unknown as ProfileMemoryService);

    await expect(recall.buildContext(user.id, '帮我做职业规划')).resolves.toMatchObject({
      version: 1,
      queryIntent: 'career_planning',
    });
  });

  test('Product Profile education fields update the existing education JSON', async () => {
    const dataSource = await createTestDataSource();
    const user = await createUser(dataSource, 'Education user');
    const profileV2 = profileV2Service(dataSource);
    const projection = productProjectionService(dataSource, profileV2);
    const mutations = new ProfileProductMutationService(
      profileV2,
      {} as ProfileMemoryService,
      projection,
    );
    const actor = {
      actorType: 'agent' as const,
      sourceType: 'user_explicit' as const,
      sourceConversationId: 'education-conversation',
      sourceMessageId: 'education-message',
    };

    let product = await projection.getProductProfile(user.id);
    expect(product.education).toMatchObject({
      level: { value: '' },
      school: { value: '' },
      major: { value: '' },
      graduationDate: { value: null },
    });

    product = await mutations.mutate(user.id, {
      expectedVersion: product.version,
      fieldKey: 'education.school',
      operation: 'set',
      value: '北京理工大学',
    }, actor);
    product = await mutations.mutate(user.id, {
      expectedVersion: product.version,
      fieldKey: 'education.major',
      operation: 'set',
      value: '计算机技术',
    }, actor);
    product = await mutations.mutate(user.id, {
      expectedVersion: product.version,
      fieldKey: 'base.educationLevel',
      operation: 'set',
      value: '硕士研究生',
    }, actor);
    product = await mutations.mutate(user.id, {
      expectedVersion: product.version,
      fieldKey: 'education.graduationDate',
      operation: 'set',
      value: '2029-06-30',
    }, actor);

    expect(product.version).toBe(5);
    expect(product.education).toMatchObject({
      level: { value: '硕士研究生' },
      school: { value: '北京理工大学' },
      major: { value: '计算机技术' },
      graduationDate: { value: '2029-06-30' },
    });
    expect((await profileV2.getBaseProfile(user.id)).educationBackground).toEqual([{
      school: '北京理工大学',
      major: '计算机技术',
      degree: '',
      graduationDate: '2029-06-30',
      description: '',
    }]);
    expect(await dataSource.getRepository(ProfileRevisionEntity).countBy({
      userId: user.id,
    })).toBe(5);

    await expect(mutations.mutate(user.id, {
      expectedVersion: product.version,
      fieldKey: 'education.graduationDate',
      operation: 'set',
      value: '2029-02-30',
    }, actor)).rejects.toThrow('must be a valid date');
    expect((await profileV2.getState(user.id)).aggregateVersion).toBe(5);

    product = await mutations.mutate(user.id, {
      expectedVersion: product.version,
      fieldKey: 'education.major',
      operation: 'clear',
    }, actor);
    expect(product.education.school.value).toBe('北京理工大学');
    expect(product.education.major.value).toBe('');
    expect((await profileV2.getBaseProfile(user.id)).educationBackground[0]).toMatchObject({
      school: '北京理工大学',
      major: '',
      graduationDate: '2029-06-30',
    });
  });

  test('interactive and refresh Profile tools use isolated schema caches', () => {
    const interactive = createProductProfileTools({
      userId: 1,
      conversationId: 'conversation',
      baseService: {} as ProfileV2Service,
      memoryService: {} as ProfileMemoryService,
      proposalService: {} as never,
      productProjectionService: {} as ProfileProductProjectionService,
      productMutationService: {} as ProfileProductMutationService,
    });
    const refresh = createProfileRefreshTools({
      snapshot: {} as never,
      allowedEvidenceRefs: new Set(),
      staged: [],
    });

    expect(interactive.find((tool) => tool.name === 'profile_read')?.schemaCacheNamespace)
      .toBe('product-profile-interactive');
    expect(interactive.find((tool) => tool.name === 'profile_update')?.schemaCacheNamespace)
      .toBe('product-profile-interactive');
    expect(refresh.find((tool) => tool.name === 'profile_read')?.schemaCacheNamespace)
      .toBe('product-profile-refresh');
    expect(refresh.find((tool) => tool.name === 'profile_update')?.schemaCacheNamespace)
      .toBe('product-profile-refresh');
  });

  test('two concurrent first snapshots both succeed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'profile-v2-race-'));
    temporaryDirectories.push(directory);
    const database = join(directory, 'profile.sqlite');
    const firstSource = new DataSource({
      type: 'sqlite',
      database,
      synchronize: true,
      entities,
    });
    dataSources.push(firstSource);
    await firstSource.initialize();
    const user = await createUser(firstSource, 'Concurrent');
    const secondSource = new DataSource({
      type: 'sqlite',
      database,
      synchronize: false,
      entities,
    });
    dataSources.push(secondSource);
    await secondSource.initialize();
    const firstProfile = profileV2Service(firstSource);
    const secondProfile = profileV2Service(secondSource);
    const firstSnapshot = new ProfileExternalSnapshotService(
      firstSource,
      firstProfile,
    );
    const secondSnapshot = new ProfileExternalSnapshotService(
      secondSource,
      secondProfile,
    );

    const [left, right] = await Promise.all([
      firstSnapshot.getCurrentSnapshot(user.id),
      secondSnapshot.getCurrentSnapshot(user.id),
    ]);

    expect(left).toEqual(right);
    expect(await firstSource.getRepository(BaseProfileEntity).countBy({
      userId: user.id,
    })).toBe(1);
    expect(await firstSource.getRepository(ProfileStateEntity).countBy({
      userId: user.id,
    })).toBe(1);
    expect(await firstSource.getRepository(ProfileRevisionEntity).countBy({
      userId: user.id,
    })).toBe(1);
    expect(await firstSource.getRepository(ProfileProjectionJobEntity).countBy({
      userId: user.id,
    })).toBe(1);
  });
});
