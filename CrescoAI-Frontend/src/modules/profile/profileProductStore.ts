import { defineStore } from 'pinia';
import { createCareerAgentClient } from '../../services/createCareerAgentClient';
import type { ProfileRecord } from '../../types/entities';
import type {
  CareerProfileProductView,
  ProfileProductField,
  ProfileProductFieldKey,
  ProfileProductValue,
  ProfileRefreshJob,
  ProfileEvidenceView,
} from './profileProductTypes';

const client = createCareerAgentClient();

function field<T extends ProfileProductValue>(
  fieldKey: ProfileProductFieldKey,
  value: T,
): ProfileProductField<T> {
  return { fieldKey, value };
}

function legacyProductView(profile: ProfileRecord): CareerProfileProductView {
  const list = (value: string | string[]) => Array.isArray(value)
    ? value
    : value.trim()
      ? value.split(/\n+/).map((item) => item.trim()).filter(Boolean)
      : [];
  return {
    schemaVersion: 'career_profile_product_v2',
    version: 1,
    header: {
      name: field('base.name', profile.basicInfo.fullName || profile.basicInfo.displayName),
      currentRole: field('base.currentRole', profile.careerProfile.currentRole),
      currentCity: field('base.currentCity', profile.basicInfo.currentCity),
      currentStatus: field('base.currentStatus', profile.careerProfile.employmentStatus),
      currentIndustry: field('base.currentIndustry', ''),
      yearsOfExperience: field('base.yearsOfExperience', null),
    },
    education: {
      level: field('base.educationLevel', ''),
      school: field('education.school', ''),
      major: field('education.major', ''),
      degree: field('education.degree', ''),
      graduationDate: field('education.graduationDate', null),
      description: field('education.description', profile.careerProfile.educationBackground),
    },
    summary: field('profile.summary', profile.artifacts.resumeSummary),
    skills: field('career.skills', profile.careerProfile.skills),
    career: {
      workExperience: field('career.workExperience', list(profile.careerProfile.workExperience)),
      projectExperience: field('career.projectExperience', list(profile.careerProfile.projectExperience)),
      direction: field('career.direction', profile.intentConstraints.careerGoal),
      searchStatus: field('job.searchStatus', profile.intentConstraints.jobSearchStatus),
    },
    jobIntent: {
      targetRoles: field('job.targetRoles', list(profile.intentConstraints.targetRole)),
      targetIndustries: field('job.targetIndustries', profile.intentConstraints.targetIndustries.length
        ? profile.intentConstraints.targetIndustries
        : list(profile.intentConstraints.targetIndustry)),
      locations: field('job.locations', list(profile.intentConstraints.targetCity)),
      workModes: field('job.workModes', profile.intentConstraints.workPreferences),
      salaryExpectation: field('job.salaryExpectation', profile.intentConstraints.expectedSalary),
      exclusions: field('job.exclusions', profile.intentConstraints.constraints),
    },
    learning: {
      goals: field('learning.goals', list(profile.planState.learningPlan)),
      activeSkills: field('learning.activeSkills', []),
      milestones: field('learning.milestones', profile.activityRecords.learningRecords),
      blockers: field('learning.blockers', []),
      nextFocus: field('learning.nextFocus', ''),
    },
    additionalHighlights: [],
  };
}

export const useProfileProductStore = defineStore('profile-product', {
  state: () => ({
    profile: null as CareerProfileProductView | null,
    loading: false,
    saving: false,
    error: null as string | null,
    refreshJob: null as ProfileRefreshJob | null,
    refreshError: null as string | null,
    evidence: null as ProfileEvidenceView | null,
    evidenceLoading: false,
    evidenceError: null as string | null,
  }),
  actions: {
    async load() {
      this.loading = true;
      this.error = null;
      try {
        this.profile = client.getProductProfile
          ? await client.getProductProfile()
          : legacyProductView(await client.getProfile());
        return this.profile;
      } catch (error) {
        this.error = error instanceof Error ? error.message : '职业画像加载失败';
        throw error;
      } finally {
        this.loading = false;
      }
    },
    async restoreRefreshJob() {
      if (!client.getCurrentProfileRefreshJob) return null;
      this.refreshJob = await client.getCurrentProfileRefreshJob();
      if (this.refreshJob && this.isRefreshActive(this.refreshJob.status)) {
        void this.pollRefreshJob(this.refreshJob.jobId);
      }
      return this.refreshJob;
    },
    async startRefresh() {
      if (!client.createProfileRefreshJob) throw new Error('当前环境暂不支持画像刷新');
      this.refreshError = null;
      try {
        this.refreshJob = await client.createProfileRefreshJob(crypto.randomUUID());
        await this.pollRefreshJob(this.refreshJob.jobId);
      } catch (error) {
        this.refreshError = error instanceof Error ? error.message : '画像刷新启动失败';
        throw error;
      }
    },
    async pollRefreshJob(jobId: string) {
      if (!client.getProfileRefreshJob) return;
      // Keep the page aligned with the backend's 600-second refresh timeout.
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const job = await client.getProfileRefreshJob(jobId);
        this.refreshJob = job;
        if (!this.isRefreshActive(job.status)) {
          if (job.status === 'succeeded' || job.status === 'partial') await this.load();
          if (job.status === 'failed') this.refreshError = '画像刷新未完成，请稍后重试';
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
      this.refreshError = '画像刷新仍在后台进行，请稍后返回查看';
    },
    async openEvidence(evidenceRef: string) {
      if (!client.getProfileEvidence) return;
      this.evidenceLoading = true;
      this.evidence = null;
      this.evidenceError = null;
      try {
        this.evidence = await client.getProfileEvidence(evidenceRef);
      } catch (error) {
        this.evidenceError = error instanceof Error ? error.message : '相关对话暂时无法读取';
        throw error;
      } finally {
        this.evidenceLoading = false;
      }
    },
    async resolveEvidenceNavigation(evidenceRef: string) {
      if (!client.getProfileEvidenceNavigation) throw new Error('当前环境暂不支持打开相关对话');
      this.evidenceError = null;
      try {
        return await client.getProfileEvidenceNavigation(evidenceRef);
      } catch (error) {
        this.evidenceError = error instanceof Error ? error.message : '对应会话暂时无法打开';
        throw error;
      }
    },
    closeEvidence() { this.evidence = null; this.evidenceError = null; },
    isRefreshActive(status: ProfileRefreshJob['status']) {
      return ['queued', 'collecting', 'running', 'applying'].includes(status);
    },
    async setField(fieldKey: ProfileProductFieldKey, value: ProfileProductValue) {
      if (!this.profile) throw new Error('职业画像尚未加载');
      this.saving = true;
      this.error = null;
      try {
        if (!client.mutateProductProfile) {
          this.applyLocalField(fieldKey, value);
          return this.profile;
        }
        this.profile = await client.mutateProductProfile({
          expectedVersion: this.profile.version,
          fieldKey,
          operation: this.isEmpty(value) ? 'clear' : 'set',
          value,
        });
        return this.profile;
      } catch (error) {
        this.error = error instanceof Error ? error.message : '职业画像保存失败';
        throw error;
      } finally {
        this.saving = false;
      }
    },
    applyLocalField(fieldKey: ProfileProductFieldKey, value: ProfileProductValue) {
      if (!this.profile) return;
      const visit = (input: unknown): boolean => {
        if (!input || typeof input !== 'object') return false;
        const record = input as Record<string, unknown>;
        if (record.fieldKey === fieldKey) {
          record.value = value;
          return true;
        }
        return Object.values(record).some(visit);
      };
      visit(this.profile);
      this.profile.version += 1;
    },
    isEmpty(value: ProfileProductValue) {
      return value === null || value === '' || (Array.isArray(value) && value.length === 0);
    },
  },
});
