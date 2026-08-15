import { ProfileV2Foundation1760000000000 } from './1760000000000-ProfileV2Foundation.js';
import { ProfileMemory1760000001000 } from './1760000001000-ProfileMemory.js';
import { ProfileProposals1760000002000 } from './1760000002000-ProfileProposals.js';
import { ProfileLevelClassification1760000003000 } from './1760000003000-ProfileLevelClassification.js';
import { ProfileIndexedMemory1760000004000 } from './1760000004000-ProfileIndexedMemory.js';
import { ConversationCleanupTasks1760000005000 } from './1760000005000-ConversationCleanupTasks.js';
import { CreateCareerAgentBaseline1785000000000 } from './1785000000000-CreateCareerAgentBaseline.js';
import { AddPublicUserId1785128058000 } from './1785128058000-AddPublicUserId.js';
import { AlignCareerAgentSchema1785128059000 } from './1785128059000-AlignCareerAgentSchema.js';
import { AddIntegrationKernel1785128060000 } from './1785128060000-AddIntegrationKernel.js';
import { ConsolidateProfileV2Snapshot1785128061000 } from './1785128061000-ConsolidateProfileV2Snapshot.js';
import { AddPraxisIntegrationDelivery1785128062000 } from './1785128062000-AddPraxisIntegrationDelivery.js';
import { ProfileEvidenceLinks1785128063000 } from './1785128063000-ProfileEvidenceLinks.js';
import { ProfileRefreshJobs1785128064000 } from './1785128064000-ProfileRefreshJobs.js';
import { PraxisBehaviorEvents1785128065000 } from './1785128065000-PraxisBehaviorEvents.js';
import { GithubMcpSettings1785128066000 } from './1785128066000-GithubMcpSettings.js';

/**
 * The exact ordered migration chain used by production and migration tests.
 * Keep this as the only runtime migration registry.
 */
export const careerAgentMigrations = [
  ProfileV2Foundation1760000000000,
  ProfileMemory1760000001000,
  ProfileProposals1760000002000,
  ProfileLevelClassification1760000003000,
  ProfileIndexedMemory1760000004000,
  ConversationCleanupTasks1760000005000,
  CreateCareerAgentBaseline1785000000000,
  AddPublicUserId1785128058000,
  AlignCareerAgentSchema1785128059000,
  AddIntegrationKernel1785128060000,
  ConsolidateProfileV2Snapshot1785128061000,
  AddPraxisIntegrationDelivery1785128062000,
  ProfileEvidenceLinks1785128063000,
  ProfileRefreshJobs1785128064000,
  PraxisBehaviorEvents1785128065000,
  GithubMcpSettings1785128066000,
];
