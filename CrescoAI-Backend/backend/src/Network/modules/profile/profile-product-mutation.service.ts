import { Injectable, Optional } from '@nestjs/common';
import type { ProfileSourceType } from './profile-v2.types';
import { ProfileMemoryService } from './profile-memory.service';
import {
  decodeProfileProductMemoryValue,
  encodeProfileProductMemoryValue,
  getProfileProductFieldDefinition,
  isListProfileProductCodec,
  normalizeProfileProductValue,
  type ProfileProductFieldDefinition,
} from './profile-product-field.registry';
import { ProfileProductProjectionService } from './profile-product-projection.service';
import type {
  ProfileProductMutationInput,
  ProfileProductValue,
} from './profile-product.types';
import { ProfileV2Service } from './profile-v2.service';
import { profileValidationError, profileVersionConflict } from './profile.errors';
import { ProfileEvidenceService } from './profile-evidence.service';

export interface ProfileProductMutationActor {
  actorType: 'user' | 'agent' | 'system';
  sourceType: ProfileSourceType;
  sourceConversationId?: string | null;
  sourceMessageId?: string | null;
}

@Injectable()
export class ProfileProductMutationService {
  constructor(
    private readonly profileV2Service: ProfileV2Service,
    private readonly memoryService: ProfileMemoryService,
    private readonly productProjection: ProfileProductProjectionService,
    @Optional() private readonly evidenceService?: ProfileEvidenceService,
  ) {}

  async mutate(
    userId: number,
    input: ProfileProductMutationInput,
    actor: ProfileProductMutationActor,
  ) {
    const before = await this.productProjection.getProductProfile(userId);
    const definition = getProfileProductFieldDefinition(input.fieldKey);
    if (!definition) throw profileValidationError('unsupported Profile product field');
    const state = await this.profileV2Service.getState(userId);
    if (state.aggregateVersion !== input.expectedVersion) {
      throw profileVersionConflict(input.expectedVersion, state.aggregateVersion);
    }

    if (definition.storage === 'base' || definition.storage === 'education') {
      if (input.operation === 'add' || input.operation === 'remove') {
        throw profileValidationError(`${input.operation} is only valid for list fields`);
      }
      const normalized = this.normalizeInput(
        definition,
        input.operation === 'clear' ? this.emptyValue(definition.codec) : input.value,
      );
      if (definition.storage === 'base') {
        await this.mutateBase(
          userId,
          definition.baseProperty!,
          normalized,
          input.expectedVersion,
          actor,
        );
      } else {
        await this.mutateEducation(
          userId,
          definition.educationProperty!,
          normalized,
          input.expectedVersion,
          actor,
        );
      }
    } else {
      await this.mutateMemory(userId, input, definition, actor);
    }
    const after = await this.productProjection.getProductProfile(userId);
    if (actor.actorType === 'user' && this.evidenceService) {
      await this.reconcileUserEvidence(userId, input.fieldKey,
        this.findValue(before, input.fieldKey), this.findValue(after, input.fieldKey));
    }
    return after;
  }

  private async mutateBase(
    userId: number,
    property: NonNullable<ReturnType<typeof getProfileProductFieldDefinition>>['baseProperty'],
    value: ProfileProductValue,
    expectedAggregateVersion: number,
    actor: ProfileProductMutationActor,
  ) {
    const base = await this.profileV2Service.getBaseProfile(userId);
    if (base[property!] === value) return;
    if (
      actor.actorType === 'agent'
      && actor.sourceType !== 'user_explicit'
      && !this.isEmptyValue(base[property!] as ProfileProductValue)
    ) {
      return;
    }
    await this.profileV2Service.updateBaseProfile(userId, {
      [property!]: value,
    }, {
      sourceType: actor.sourceType,
      sourceConversationId: actor.sourceConversationId,
      sourceMessageId: actor.sourceMessageId,
      actorType: actor.actorType,
      userConfirmed: actor.actorType === 'user',
      updateLevel: 'L3',
      expectedVersion: base.version,
      expectedAggregateVersion,
    });
  }

  private async mutateMemory(
    userId: number,
    input: ProfileProductMutationInput,
    definition: ProfileProductFieldDefinition,
    actor: ProfileProductMutationActor,
  ) {
    const memories = await this.memoryService.findActiveEntities(userId);
    const slots = new Set([definition.slotKey!, ...(definition.aliases ?? [])]);
    const candidates = memories
      .filter((memory) => slots.has(memory.slotKey))
      .sort((left, right) => {
        const leftCanonical = left.slotKey === definition.slotKey ? 1 : 0;
        const rightCanonical = right.slotKey === definition.slotKey ? 1 : 0;
        return rightCanonical - leftCanonical || right.updatedAt.getTime() - left.updatedAt.getTime();
      });
    const current = candidates[0];
    if (
      (input.operation === 'add' || input.operation === 'remove')
      && !isListProfileProductCodec(definition.codec)
    ) {
      throw profileValidationError(`${input.operation} is only valid for list fields`);
    }
    if (
      actor.actorType === 'agent'
      && actor.sourceType !== 'user_explicit'
      && current
      && (input.operation === 'set' || input.operation === 'clear' || input.operation === 'remove')
    ) {
      return;
    }
    const currentValue = decodeProfileProductMemoryValue(definition, current?.content);
    const value = this.resolveMemoryValue(definition, input, currentValue);
    const content = encodeProfileProductMemoryValue(definition, value);
    const empty = content === '' || content === '[]';
    const meta = {
      sourceType: actor.sourceType,
      sourceConversationId: actor.sourceConversationId,
      sourceMessageId: actor.sourceMessageId,
      actorType: actor.actorType,
      userConfirmed: actor.actorType === 'user',
      updateLevel: definition.internalLevel,
    } as const;

    if (empty) {
      let version = input.expectedVersion;
      for (const candidate of candidates) {
        await this.memoryService.update(userId, candidate.id, {
          expectedVersion: version,
          status: 'deleted',
        }, meta);
        version += 1;
      }
      return;
    }

    if (current?.content === content && current.slotKey === definition.slotKey) return;

    if (current?.profileIndex) {
      await this.memoryService.replaceByIndex(userId, current.profileIndex, {
        expectedVersion: input.expectedVersion,
        content,
        profileLevel: definition.internalLevel,
        category: definition.category,
        slotKey: definition.slotKey,
        appliesTo: [...definition.appliesTo],
        timeScope: definition.timeScope,
        priority: definition.priority,
        expiresAt: definition.timeScope === 'long_term' ? null : undefined,
      }, meta);
      return;
    }

    if (current) {
      await this.memoryService.update(userId, current.id, {
        expectedVersion: input.expectedVersion,
        content,
        category: definition.category,
        slotKey: definition.slotKey,
        appliesTo: [...definition.appliesTo],
        timeScope: definition.timeScope,
        priority: definition.priority,
        profileLevel: definition.internalLevel,
      }, meta);
      return;
    }

    await this.memoryService.create(userId, {
      expectedVersion: input.expectedVersion,
      content,
      category: definition.category,
      slotKey: definition.slotKey,
      appliesTo: [...definition.appliesTo],
      timeScope: definition.timeScope,
      priority: definition.priority,
      profileLevel: definition.internalLevel,
      expiresAt: undefined,
    }, meta);
  }

  private async mutateEducation(
    userId: number,
    property: NonNullable<ProfileProductFieldDefinition['educationProperty']>,
    value: ProfileProductValue,
    expectedAggregateVersion: number,
    actor: ProfileProductMutationActor,
  ) {
    const base = await this.profileV2Service.getBaseProfile(userId);
    const current = base.educationBackground[0] ?? {
      school: '',
      major: '',
      degree: '',
      graduationDate: null,
      description: '',
    };
    const normalized = property === 'graduationDate'
      ? (typeof value === 'string' ? value : null)
      : String(value ?? '');
    if (current[property] === normalized) return;
    if (
      actor.actorType === 'agent'
      && actor.sourceType !== 'user_explicit'
      && !this.isEmptyValue(current[property])
    ) {
      return;
    }

    const primary = { ...current, [property]: normalized };
    const educationBackground = base.educationBackground.map((item) => ({ ...item }));
    const hasContent = Object.values(primary).some((item) => item !== null && item !== '');
    if (hasContent) {
      if (educationBackground.length) educationBackground[0] = primary;
      else educationBackground.push(primary);
    } else if (educationBackground.length) {
      educationBackground.shift();
    }

    await this.profileV2Service.updateBaseProfile(userId, {
      educationBackground,
    }, {
      sourceType: actor.sourceType,
      sourceConversationId: actor.sourceConversationId,
      sourceMessageId: actor.sourceMessageId,
      actorType: actor.actorType,
      userConfirmed: actor.actorType === 'user',
      updateLevel: 'L3',
      expectedVersion: base.version,
      expectedAggregateVersion,
    });
  }

  private emptyValue(codec: ProfileProductFieldDefinition['codec']): ProfileProductValue {
    if (isListProfileProductCodec(codec)) return [];
    if (codec === 'number' || codec === 'date') return null;
    return '';
  }

  private normalizeInput(
    definition: ProfileProductFieldDefinition,
    value: unknown,
  ) {
    try {
      return normalizeProfileProductValue(definition, value);
    } catch (error) {
      throw profileValidationError(
        error instanceof Error ? error.message : 'invalid Profile product value',
      );
    }
  }

  private resolveMemoryValue(
    definition: ProfileProductFieldDefinition,
    input: ProfileProductMutationInput,
    currentValue: ProfileProductValue,
  ): ProfileProductValue {
    if (input.operation === 'clear') return this.emptyValue(definition.codec);
    const incoming = this.normalizeInput(definition, input.value);
    if (input.operation === 'set') return incoming;

    const current = Array.isArray(currentValue) ? currentValue : [];
    const delta = Array.isArray(incoming) ? incoming : [];
    if (input.operation === 'add') {
      return this.normalizeInput(definition, [...current, ...delta]);
    }
    const removed = new Set(delta.map((item) => item.toLocaleLowerCase()));
    return current.filter((item) => !removed.has(item.toLocaleLowerCase()));
  }

  private isEmptyValue(value: ProfileProductValue) {
    return value === null || value === '' || (Array.isArray(value) && value.length === 0);
  }

  private async reconcileUserEvidence(
    userId: number,
    fieldKey: ProfileProductMutationInput['fieldKey'],
    before: ProfileProductValue,
    after: ProfileProductValue,
  ) {
    if (Array.isArray(before) && Array.isArray(after)) {
      const retained = new Set(after.map((value) => value.normalize('NFKC').toLocaleLowerCase()));
      for (const value of before) {
        if (!retained.has(value.normalize('NFKC').toLocaleLowerCase())) {
          await this.evidenceService!.invalidateTarget(userId, fieldKey, value);
        }
      }
      return;
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      await this.evidenceService!.invalidateTarget(userId, fieldKey);
    }
  }

  private findValue(view: unknown, fieldKey: ProfileProductMutationInput['fieldKey']): ProfileProductValue {
    if (!view || typeof view !== 'object') return null;
    const record = view as Record<string, unknown>;
    if (record.fieldKey === fieldKey) return record.value as ProfileProductValue;
    for (const child of Object.values(record)) {
      const value = this.findValue(child, fieldKey);
      if (value !== null) return value;
    }
    return null;
  }
}
