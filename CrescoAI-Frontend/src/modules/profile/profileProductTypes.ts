export type ProfileProductFieldKey =
  | 'base.name'
  | 'base.currentRole'
  | 'base.currentCity'
  | 'base.currentStatus'
  | 'base.currentIndustry'
  | 'base.yearsOfExperience'
  | 'base.educationLevel'
  | 'education.school'
  | 'education.major'
  | 'education.degree'
  | 'education.graduationDate'
  | 'education.description'
  | 'profile.summary'
  | 'career.skills'
  | 'career.workExperience'
  | 'career.projectExperience'
  | 'career.direction'
  | 'job.targetRoles'
  | 'job.targetIndustries'
  | 'job.locations'
  | 'job.workModes'
  | 'job.salaryExpectation'
  | 'job.exclusions'
  | 'job.searchStatus'
  | 'learning.goals'
  | 'learning.activeSkills'
  | 'learning.milestones'
  | 'learning.blockers'
  | 'learning.nextFocus';

export type ProfileProductValue = string | string[] | number | null;

export interface ProfileProductField<T extends ProfileProductValue = ProfileProductValue> {
  fieldKey: ProfileProductFieldKey;
  value: T;
  relatedConversation?: ProfileRelatedConversation;
}

export interface ProfileRelatedConversation { ref: string; count: number }
export interface ProfileProductListItem {
  itemKey: string;
  value: string;
  relatedConversation?: ProfileRelatedConversation;
}
export interface ProfileProductListField extends ProfileProductField<string[]> {
  items?: ProfileProductListItem[];
}

export interface CareerProfileProductView {
  schemaVersion: 'career_profile_product_v1' | 'career_profile_product_v2';
  version: number;
  header: {
    name: ProfileProductField<string>;
    currentRole: ProfileProductField<string>;
    currentCity: ProfileProductField<string>;
    currentStatus: ProfileProductField<string>;
    currentIndustry: ProfileProductField<string>;
    yearsOfExperience: ProfileProductField<number | null>;
  };
  education: {
    level: ProfileProductField<string>;
    school: ProfileProductField<string>;
    major: ProfileProductField<string>;
    degree: ProfileProductField<string>;
    graduationDate: ProfileProductField<string | null>;
    description: ProfileProductField<string>;
  };
  summary: ProfileProductField<string>;
  skills: ProfileProductListField;
  career: {
    workExperience: ProfileProductListField;
    projectExperience: ProfileProductListField;
    direction: ProfileProductField<string>;
    searchStatus: ProfileProductField<string>;
  };
  jobIntent: {
    targetRoles: ProfileProductListField;
    targetIndustries: ProfileProductListField;
    locations: ProfileProductListField;
    workModes: ProfileProductListField;
    salaryExpectation: ProfileProductField<string>;
    exclusions: ProfileProductListField;
  };
  learning: {
    goals: ProfileProductListField;
    activeSkills: ProfileProductListField;
    milestones: ProfileProductListField;
    blockers: ProfileProductListField;
    nextFocus: ProfileProductField<string>;
  };
  additionalHighlights: string[];
}

export type ProfileRefreshJobStatus =
  | 'queued' | 'collecting' | 'running' | 'applying'
  | 'succeeded' | 'partial' | 'failed' | 'cancelled';

export interface ProfileRefreshJob {
  jobId: string;
  status: ProfileRefreshJobStatus;
  coverage: 'complete' | 'bounded' | 'unavailable';
  profileVersionBefore: number | null;
  profileVersionAfter: number | null;
  counts: {
    candidates: number; selectedEvidence: number; added: number; updated: number;
    verified: number; removed: number; unchanged: number; skipped: number;
  };
  errorCode: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string | null;
}

export interface ProfileEvidenceConversation {
  ref: string;
  title: string;
  updatedAt: string;
  excerpt: string;
  openConversationRef: string;
}

export interface ProfileEvidenceView {
  ref: string;
  count: number;
  relatedConversations: ProfileEvidenceConversation[];
}

export interface ProfileEvidenceNavigation {
  threadId: string;
}

export interface ProfileProductMutationInput {
  expectedVersion: number;
  fieldKey: ProfileProductFieldKey;
  operation: 'set' | 'clear' | 'add' | 'remove';
  value?: ProfileProductValue;
}
