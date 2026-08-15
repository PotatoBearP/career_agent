import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtifactEntity } from './modules/artifact/entities/artifact.entity.js';
import { ConversationEntity } from './modules/conversation/entities/conversation.entity.js';
import { ConversationCleanupTaskEntity } from './modules/conversation/entities/conversation-cleanup-task.entity.js';
import { MessageEntity } from './modules/conversation/entities/message.entity.js';
import { GeneratedAppEntity } from './modules/generated-app/entities/generated-app.entity.js';
import { MemoryEntity } from './modules/memory/entities/memory.entity.js';
import { IntegrationOutboxEntity } from './modules/integration/entities/integration-outbox.entity.js';
import { PraxisBehaviorEventEntity } from './modules/integration/entities/praxis-behavior-event.entity.js';
import { BaseProfileEntity } from './modules/profile/entities/base-profile.entity.js';
import { ProfileChangeProposalEntity } from './modules/profile/entities/profile-change-proposal.entity.js';
import { ProfileMemoryItemEntity } from './modules/profile/entities/profile-memory-item.entity.js';
import { ProfileProjectionJobEntity } from './modules/profile/entities/profile-projection-job.entity.js';
import { ProfileRevisionEntity } from './modules/profile/entities/profile-revision.entity.js';
import { ProfileStateEntity } from './modules/profile/entities/profile-state.entity.js';
import { ProfileSuggestionEntity } from './modules/profile/entities/profile-suggestion.entity.js';
import { ProfileEvidenceLinkEntity } from './modules/profile/entities/profile-evidence-link.entity.js';
import { ProfileRefreshJobEntity } from './modules/profile/entities/profile-refresh-job.entity.js';
import { ResourceEntity } from './modules/resource/entities/resource.entity.js';
import { ApiSettingsEntity } from './modules/settings/entities/api-settings.entity.js';
import { McpSettingEntity } from './modules/settings/entities/mcp-setting.entity.js';
import { TeamEntity } from './modules/team/entities/team.entity.js';
import { UserEntity } from './modules/user/entities/user.entity.js';

const networkDir = dirname(fileURLToPath(import.meta.url));

export const careerAgentDatabasePath =
  process.env.CAREER_AGENT_DATABASE_PATH
  ?? join(networkDir, 'data', 'test.sqlite');

export const careerAgentEntities = [
  UserEntity,
  ArtifactEntity,
  ConversationEntity,
  ConversationCleanupTaskEntity,
  MessageEntity,
  TeamEntity,
  MemoryEntity,
  ApiSettingsEntity,
  McpSettingEntity,
  ResourceEntity,
  GeneratedAppEntity,
  ProfileSuggestionEntity,
  BaseProfileEntity,
  ProfileStateEntity,
  ProfileRevisionEntity,
  ProfileMemoryItemEntity,
  ProfileProjectionJobEntity,
  ProfileChangeProposalEntity,
  ProfileEvidenceLinkEntity,
  ProfileRefreshJobEntity,
  IntegrationOutboxEntity,
  PraxisBehaviorEventEntity,
];
