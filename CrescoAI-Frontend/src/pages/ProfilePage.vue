<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import MobileRailTrigger from '../modules/navigation/MobileRailTrigger.vue';
import ProfileRelatedConversations from '../modules/profile/ProfileRelatedConversations.vue';
import { useRouter } from 'vue-router';
import { useProfileProductStore } from '../modules/profile/profileProductStore';
import type {
  CareerProfileProductView,
  ProfileProductField,
  ProfileProductFieldKey,
  ProfileProductValue,
} from '../modules/profile/profileProductTypes';

const store = useProfileProductStore();
const router = useRouter();
const { profile, loading, saving, error, refreshJob, refreshError, evidence, evidenceLoading, evidenceError } = storeToRefs(store);
const editing = ref(false);
const draft = ref<CareerProfileProductView | null>(null);
const saveMessage = ref('');
const evidenceUiFlag = import.meta.env.VITE_CAREER_AGENT_PROFILE_EVIDENCE_UI;
const evidenceUiEnabled = evidenceUiFlag === undefined
  || !['0', 'false', 'off', 'no'].includes(String(evidenceUiFlag).trim().toLowerCase());

onMounted(() => {
  void store.load();
  if (evidenceUiEnabled) void store.restoreRefreshJob();
});

const refreshActive = computed(() => refreshJob.value
  ? store.isRefreshActive(refreshJob.value.status)
  : false);
const refreshStatusText = computed(() => {
  if (!refreshJob.value) return '';
  const labels = {
    queued: '等待整理历史对话', collecting: '正在检索历史摘要', running: '正在提炼画像',
    applying: '正在更新画像', succeeded: '画像已刷新', partial: '画像已刷新，部分内容因冲突保留',
    failed: '刷新未完成', cancelled: '刷新已取消',
  } as const;
  const base = labels[refreshJob.value.status];
  if (refreshJob.value.status !== 'succeeded' && refreshJob.value.status !== 'partial') return base;
  const counts = refreshJob.value.counts;
  return `${base} · 新增 ${counts.added}，更新 ${counts.updated}，关联 ${counts.verified}`;
});

async function refreshProfile() {
  try { await store.startRefresh(); } catch { /* Store exposes the page-only error. */ }
}

async function showEvidence(refValue: string) {
  try { await store.openEvidence(refValue); } catch { /* Missing/stale evidence stays hidden. */ }
}

async function openRelatedConversation(refValue: string) {
  store.closeEvidence();
  await router.push({ name: 'related-thread', params: { evidenceRef: refValue } });
}

const subtitle = computed(() => {
  if (!profile.value) return '逐步完善你的职业方向、求职偏好与成长进度';
  return [
    profile.value.header.currentRole.value,
    profile.value.header.currentCity.value,
    profile.value.header.currentStatus.value,
  ].filter(Boolean).join(' · ') || '逐步完善你的职业方向、求职偏好与成长进度';
});

function cloneProfile(value: CareerProfileProductView) {
  return JSON.parse(JSON.stringify(value)) as CareerProfileProductView;
}

function beginEditing() {
  if (!profile.value) return;
  draft.value = cloneProfile(profile.value);
  editing.value = true;
  saveMessage.value = '';
}

function cancelEditing() {
  draft.value = null;
  editing.value = false;
  saveMessage.value = '';
}

function listText(field: ProfileProductField<string[]>) {
  return field.value.join('，');
}

function updateList(field: ProfileProductField<string[]>, event: Event) {
  const value = (event.target as HTMLInputElement).value;
  field.value = value
    .split(/[，,\n]/)
    .map((item) => item.trim())
    .filter((item, index, values) => item && values.indexOf(item) === index);
}

function lineText(field: ProfileProductField<string[]>) {
  return field.value.join('\n');
}

function updateLines(field: ProfileProductField<string[]>, event: Event) {
  const value = (event.target as HTMLTextAreaElement).value;
  field.value = value
    .split(/\n+/)
    .map((item) => item.trim())
    .filter((item, index, values) => item && values.indexOf(item) === index);
}

function collectFields(value: CareerProfileProductView) {
  const result = new Map<ProfileProductFieldKey, ProfileProductValue>();
  const visit = (input: unknown) => {
    if (!input || typeof input !== 'object') return;
    const record = input as Record<string, unknown>;
    if (typeof record.fieldKey === 'string' && 'value' in record) {
      result.set(record.fieldKey as ProfileProductFieldKey, record.value as ProfileProductValue);
      return;
    }
    Object.values(record).forEach(visit);
  };
  visit(value);
  return result;
}

async function save() {
  if (!profile.value || !draft.value) return;
  const before = collectFields(profile.value);
  const after = collectFields(draft.value);
  const changed = [...after.entries()].filter(([key, value]) =>
    JSON.stringify(before.get(key)) !== JSON.stringify(value));
  try {
    for (const [key, value] of changed) {
      await store.setField(key, value);
    }
    editing.value = false;
    draft.value = null;
    saveMessage.value = changed.length ? '职业画像已保存' : '没有需要保存的变化';
  } catch {
    saveMessage.value = '保存失败，草稿仍保留在当前页面';
  }
}

function hasContent(values: string[]) {
  return values.length > 0;
}
</script>

<template>
  <section class="page-section profile-page">
    <header class="profile-hero">
      <div class="hero-copy">
        <MobileRailTrigger />
        <p class="eyebrow">我的职业画像</p>
        <h1>{{ profile?.header.name.value || '完善你的职业画像' }}</h1>
        <p>{{ subtitle }}</p>
        <div v-if="profile && evidenceUiEnabled" class="hero-related">
          <ProfileRelatedConversations :field="profile.header.name" label="姓名" @open="showEvidence" />
          <ProfileRelatedConversations :field="profile.header.currentRole" label="当前岗位" @open="showEvidence" />
          <ProfileRelatedConversations :field="profile.header.currentCity" label="所在城市" @open="showEvidence" />
          <ProfileRelatedConversations :field="profile.header.currentStatus" label="当前状态" @open="showEvidence" />
          <ProfileRelatedConversations :field="profile.header.currentIndustry" label="当前行业" @open="showEvidence" />
          <ProfileRelatedConversations :field="profile.header.yearsOfExperience" label="工作年限" @open="showEvidence" />
        </div>
      </div>
      <div class="hero-actions">
        <span v-if="saveMessage" class="save-message">{{ saveMessage }}</span>
        <button v-if="!editing && evidenceUiEnabled" class="secondary-button" :disabled="!profile || loading || refreshActive" @click="refreshProfile">
          {{ refreshActive ? '正在刷新画像…' : '从历史对话刷新画像' }}
        </button>
        <button v-if="!editing" class="primary-button" :disabled="!profile || loading" @click="beginEditing">
          编辑画像
        </button>
        <template v-else>
          <button class="secondary-button" :disabled="saving" @click="cancelEditing">取消</button>
          <button class="primary-button" :disabled="saving" @click="save">
            {{ saving ? '保存中...' : '保存画像' }}
          </button>
        </template>
      </div>
    </header>

    <div v-if="evidenceUiEnabled && (refreshStatusText || refreshError)" class="refresh-state" :class="{ error: refreshError }">
      {{ refreshError || refreshStatusText }}
    </div>

    <section v-if="loading" class="state-card">
      <h2>正在加载职业画像...</h2>
    </section>
    <section v-else-if="error && !profile" class="state-card error">
      <h2>画像加载失败</h2>
      <p>{{ error }}</p>
      <button class="secondary-button" @click="store.load()">重新加载</button>
    </section>

    <template v-else-if="profile">
      <div v-if="editing && draft" class="profile-grid editor-grid">
        <section class="profile-card span-2">
          <div class="card-heading"><p class="eyebrow">基本信息</p><h2>当前职业状态</h2></div>
          <div class="form-grid">
            <label>姓名<input v-model="draft.header.name.value" /></label>
            <label>当前岗位<input v-model="draft.header.currentRole.value" /></label>
            <label>所在城市<input v-model="draft.header.currentCity.value" /></label>
            <label>当前状态<input v-model="draft.header.currentStatus.value" /></label>
            <label>当前行业<input v-model="draft.header.currentIndustry.value" /></label>
            <label>工作年限<input v-model.number="draft.header.yearsOfExperience.value" type="number" min="0" max="80" step="0.5" /></label>
          </div>
        </section>

        <section class="profile-card span-2">
          <div class="card-heading"><p class="eyebrow">教育背景</p><h2>主教育经历</h2></div>
          <div class="form-grid">
            <label>学历层次<input v-model="draft.education.level.value" placeholder="例如：硕士研究生" /></label>
            <label>学校<input v-model="draft.education.school.value" /></label>
            <label>专业<input v-model="draft.education.major.value" /></label>
            <label>学位<input v-model="draft.education.degree.value" placeholder="例如：工学硕士" /></label>
            <label>预计毕业日期<input v-model="draft.education.graduationDate.value" type="date" /></label>
            <label>补充说明<input v-model="draft.education.description.value" placeholder="例如：研一在读" /></label>
          </div>
        </section>

        <section class="profile-card span-2">
          <div class="card-heading"><p class="eyebrow">职业概述</p><h2>用几句话介绍现在的你</h2></div>
          <textarea v-model="draft.summary.value" rows="5" placeholder="例如：具备 Java 后端和微服务经验，希望转向 AI Infra 方向。" />
        </section>

        <section class="profile-card">
          <div class="card-heading"><p class="eyebrow">能力</p><h2>核心技能</h2></div>
          <textarea :value="listText(draft.skills)" rows="4" placeholder="使用逗号分隔，例如 Java，Spring Boot，Kubernetes" @input="updateList(draft.skills, $event)" />
        </section>

        <section class="profile-card">
          <div class="card-heading"><p class="eyebrow">方向</p><h2>职业方向与求职状态</h2></div>
          <label>发展方向<textarea v-model="draft.career.direction.value" rows="3" /></label>
          <label>求职状态<input v-model="draft.career.searchStatus.value" /></label>
        </section>

        <section class="profile-card span-2">
          <div class="card-heading"><p class="eyebrow">求职意向</p><h2>下一份工作希望是什么样</h2></div>
          <div class="form-grid">
            <label>目标岗位<input :value="listText(draft.jobIntent.targetRoles)" @input="updateList(draft.jobIntent.targetRoles, $event)" /></label>
            <label>目标行业<input :value="listText(draft.jobIntent.targetIndustries)" @input="updateList(draft.jobIntent.targetIndustries, $event)" /></label>
            <label>期望地点<input :value="listText(draft.jobIntent.locations)" @input="updateList(draft.jobIntent.locations, $event)" /></label>
            <label>工作方式<input :value="listText(draft.jobIntent.workModes)" @input="updateList(draft.jobIntent.workModes, $event)" /></label>
            <label>薪资期望<input v-model="draft.jobIntent.salaryExpectation.value" /></label>
            <label>不考虑的条件<input :value="listText(draft.jobIntent.exclusions)" @input="updateList(draft.jobIntent.exclusions, $event)" /></label>
          </div>
        </section>

        <section class="profile-card span-2">
          <div class="card-heading"><p class="eyebrow">经历</p><h2>工作与项目经验</h2></div>
          <div class="form-grid">
            <label>工作经历<textarea :value="lineText(draft.career.workExperience)" rows="6" placeholder="每行填写一段工作经历" @input="updateLines(draft.career.workExperience, $event)" /></label>
            <label>项目经历<textarea :value="lineText(draft.career.projectExperience)" rows="6" placeholder="每行填写一段项目经历" @input="updateLines(draft.career.projectExperience, $event)" /></label>
          </div>
        </section>

        <section class="profile-card span-2">
          <div class="card-heading"><p class="eyebrow">学习与成长</p><h2>正在提升什么</h2></div>
          <div class="form-grid">
            <label>学习目标<textarea :value="listText(draft.learning.goals)" rows="3" @input="updateList(draft.learning.goals, $event)" /></label>
            <label>正在提升<input :value="listText(draft.learning.activeSkills)" placeholder="例如 Kubernetes｜有练习经验" @input="updateList(draft.learning.activeSkills, $event)" /></label>
            <label>近期里程碑<textarea :value="listText(draft.learning.milestones)" rows="3" @input="updateList(draft.learning.milestones, $event)" /></label>
            <label>当前难点<textarea :value="listText(draft.learning.blockers)" rows="3" @input="updateList(draft.learning.blockers, $event)" /></label>
            <label class="span-2">下一步重点<textarea v-model="draft.learning.nextFocus.value" rows="3" /></label>
          </div>
        </section>
      </div>

      <div v-else class="profile-grid">
        <section class="profile-card span-2">
          <div class="card-heading"><p class="eyebrow">教育背景</p><h2>主教育经历</h2></div>
          <dl class="intent-grid">
            <div><dt>学历层次</dt><dd>{{ profile.education.level.value || '待补充' }}</dd><ProfileRelatedConversations v-if="evidenceUiEnabled" :field="profile.education.level" @open="showEvidence" /></div>
            <div><dt>学校</dt><dd>{{ profile.education.school.value || '待补充' }}</dd><ProfileRelatedConversations v-if="evidenceUiEnabled" :field="profile.education.school" @open="showEvidence" /></div>
            <div><dt>专业</dt><dd>{{ profile.education.major.value || '待补充' }}</dd><ProfileRelatedConversations v-if="evidenceUiEnabled" :field="profile.education.major" @open="showEvidence" /></div>
            <div><dt>学位</dt><dd>{{ profile.education.degree.value || '待补充' }}</dd><ProfileRelatedConversations v-if="evidenceUiEnabled" :field="profile.education.degree" @open="showEvidence" /></div>
            <div><dt>预计毕业日期</dt><dd>{{ profile.education.graduationDate.value || '待补充' }}</dd><ProfileRelatedConversations v-if="evidenceUiEnabled" :field="profile.education.graduationDate" @open="showEvidence" /></div>
            <div><dt>补充说明</dt><dd>{{ profile.education.description.value || '暂无' }}</dd><ProfileRelatedConversations v-if="evidenceUiEnabled" :field="profile.education.description" @open="showEvidence" /></div>
          </dl>
        </section>

        <section class="profile-card span-2 summary-card">
          <div class="card-heading"><p class="eyebrow">职业概述</p><h2>现在的我</h2></div>
          <p v-if="profile.summary.value" class="summary-copy">{{ profile.summary.value }}</p>
          <p v-else class="empty-copy">补充一段职业概述，让岗位、简历和学习建议更贴近你。</p>
          <ProfileRelatedConversations v-if="evidenceUiEnabled" :field="profile.summary" @open="showEvidence" />
        </section>

        <section class="profile-card">
          <div class="card-heading"><p class="eyebrow">能力</p><h2>核心技能</h2></div>
          <div v-if="hasContent(profile.skills.value)" class="chip-list">
            <span v-for="skill in profile.skills.value" :key="skill" class="profile-chip">
              {{ skill }}
            </span>
          </div>
          <p v-else class="empty-copy">还没有添加核心技能。</p>
          <ProfileRelatedConversations v-if="evidenceUiEnabled" :field="profile.skills" @open="showEvidence" />
        </section>

        <section class="profile-card">
          <div class="card-heading"><p class="eyebrow">方向</p><h2>职业目标</h2></div>
          <p>{{ profile.career.direction.value || '还没有设置长期职业方向。' }}</p>
          <ProfileRelatedConversations v-if="evidenceUiEnabled" :field="profile.career.direction" label="职业方向" @open="showEvidence" />
          <p v-if="profile.career.searchStatus.value" class="muted-line">当前状态：{{ profile.career.searchStatus.value }}</p>
          <ProfileRelatedConversations v-if="evidenceUiEnabled" :field="profile.career.searchStatus" label="求职状态" @open="showEvidence" />
        </section>

        <section class="profile-card span-2">
          <div class="card-heading"><p class="eyebrow">求职意向</p><h2>下一份工作的偏好</h2></div>
          <dl class="intent-grid">
            <div><dt>目标岗位</dt><dd>{{ profile.jobIntent.targetRoles.value.join('、') || '待补充' }}</dd><ProfileRelatedConversations v-if="evidenceUiEnabled" :field="profile.jobIntent.targetRoles" @open="showEvidence" /></div>
            <div><dt>目标行业</dt><dd>{{ profile.jobIntent.targetIndustries.value.join('、') || '待补充' }}</dd><ProfileRelatedConversations v-if="evidenceUiEnabled" :field="profile.jobIntent.targetIndustries" @open="showEvidence" /></div>
            <div><dt>期望地点</dt><dd>{{ profile.jobIntent.locations.value.join('、') || '待补充' }}</dd><ProfileRelatedConversations v-if="evidenceUiEnabled" :field="profile.jobIntent.locations" @open="showEvidence" /></div>
            <div><dt>工作方式</dt><dd>{{ profile.jobIntent.workModes.value.join('、') || '待补充' }}</dd><ProfileRelatedConversations v-if="evidenceUiEnabled" :field="profile.jobIntent.workModes" @open="showEvidence" /></div>
            <div><dt>薪资期望</dt><dd>{{ profile.jobIntent.salaryExpectation.value || '待补充' }}</dd><ProfileRelatedConversations v-if="evidenceUiEnabled" :field="profile.jobIntent.salaryExpectation" @open="showEvidence" /></div>
            <div><dt>不考虑</dt><dd>{{ profile.jobIntent.exclusions.value.join('、') || '暂无' }}</dd><ProfileRelatedConversations v-if="evidenceUiEnabled" :field="profile.jobIntent.exclusions" @open="showEvidence" /></div>
          </dl>
        </section>

        <section class="profile-card span-2">
          <div class="card-heading"><p class="eyebrow">经历</p><h2>工作与项目经验</h2></div>
          <div class="growth-grid">
            <div><h3>工作经历</h3><ul v-if="profile.career.workExperience.value.length"><li v-for="item in profile.career.workExperience.value" :key="item">{{ item }}</li></ul><p v-else class="empty-copy">还没有补充工作经历。</p><ProfileRelatedConversations v-if="evidenceUiEnabled" :field="profile.career.workExperience" @open="showEvidence" /></div>
            <div><h3>项目经历</h3><ul v-if="profile.career.projectExperience.value.length"><li v-for="item in profile.career.projectExperience.value" :key="item">{{ item }}</li></ul><p v-else class="empty-copy">还没有补充项目经历。</p><ProfileRelatedConversations v-if="evidenceUiEnabled" :field="profile.career.projectExperience" @open="showEvidence" /></div>
          </div>
        </section>

        <section class="profile-card span-2">
          <div class="card-heading"><p class="eyebrow">学习与成长</p><h2>持续提升</h2></div>
          <div class="growth-grid">
            <div><h3>当前目标</h3><ul v-if="profile.learning.goals.value.length"><li v-for="item in profile.learning.goals.value" :key="item">{{ item }}</li></ul><p v-else class="empty-copy">还没有设置学习目标。</p><ProfileRelatedConversations v-if="evidenceUiEnabled" :field="profile.learning.goals" @open="showEvidence" /></div>
            <div><h3>正在提升</h3><ul v-if="profile.learning.activeSkills.value.length"><li v-for="item in profile.learning.activeSkills.value" :key="item">{{ item }}</li></ul><p v-else class="empty-copy">还没有正在提升的技能。</p><ProfileRelatedConversations v-if="evidenceUiEnabled" :field="profile.learning.activeSkills" @open="showEvidence" /></div>
            <div><h3>近期里程碑</h3><ul v-if="profile.learning.milestones.value.length"><li v-for="item in profile.learning.milestones.value" :key="item">{{ item }}</li></ul><p v-else class="empty-copy">完成练习或项目后，会在这里形成成长记录。</p><ProfileRelatedConversations v-if="evidenceUiEnabled" :field="profile.learning.milestones" @open="showEvidence" /></div>
            <div><h3>下一步重点</h3><p>{{ profile.learning.nextFocus.value || '待补充' }}</p><ProfileRelatedConversations v-if="evidenceUiEnabled" :field="profile.learning.nextFocus" label="下一步重点" @open="showEvidence" /><p v-if="profile.learning.blockers.value.length" class="muted-line">当前难点：{{ profile.learning.blockers.value.join('、') }}</p><ProfileRelatedConversations v-if="evidenceUiEnabled" :field="profile.learning.blockers" label="当前难点" @open="showEvidence" /></div>
          </div>
        </section>

        <section v-if="profile.additionalHighlights.length" class="profile-card span-2">
          <div class="card-heading"><p class="eyebrow">更多信息</p><h2>其他职业画像内容</h2></div>
          <ul><li v-for="item in profile.additionalHighlights" :key="item">{{ item }}</li></ul>
        </section>
      </div>
    </template>

    <div v-if="evidenceUiEnabled && (evidenceLoading || evidence || evidenceError)" class="evidence-backdrop" @click.self="store.closeEvidence()">
      <aside class="evidence-drawer" aria-label="相关对话">
        <div class="drawer-heading">
          <div><p class="eyebrow">相关对话</p><h2>{{ evidence ? `${evidence.count} 个相关会话` : '正在读取…' }}</h2></div>
          <button class="drawer-close" aria-label="关闭" @click="store.closeEvidence()">×</button>
        </div>
        <div v-if="evidence" class="evidence-list">
          <article v-for="conversation in evidence.relatedConversations" :key="conversation.ref" class="evidence-item">
            <h3>{{ conversation.title }}</h3>
            <p v-if="conversation.updatedAt" class="muted-line">{{ new Date(conversation.updatedAt).toLocaleString() }}</p>
            <p class="evidence-excerpt">{{ conversation.excerpt }}</p>
            <button class="primary-button evidence-open" @click="openRelatedConversation(conversation.openConversationRef)">
              打开对应会话
            </button>
          </article>
        </div>
        <p v-else-if="evidenceLoading" class="muted-line">正在读取相关内容…</p>
        <p v-else class="evidence-error">{{ evidenceError }}</p>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.profile-page { display: grid; gap: 20px; }
.profile-hero { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; padding: 26px; border: 1px solid var(--color-border); border-radius: 22px; background: linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 10%, var(--color-surface)), var(--color-surface)); }
.hero-copy { display: grid; gap: 7px; }
.hero-copy h1 { margin: 0; font-size: clamp(1.8rem, 4vw, 3rem); }
.hero-copy p { margin: 0; color: var(--color-text-muted); }
.hero-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.save-message { color: var(--color-text-muted); font-size: .9rem; }
.refresh-state { padding: 11px 14px; border-radius: 12px; color: var(--color-text-muted); background: var(--color-bg-subtle); }
.refresh-state.error { color: #b3261e; }
.profile-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.profile-card { display: grid; align-content: start; gap: 14px; padding: 20px; border: 1px solid var(--color-border); border-radius: 18px; background: var(--color-surface); box-shadow: 0 8px 24px color-mix(in srgb, var(--color-text) 5%, transparent); }
.span-2 { grid-column: span 2; }
.card-heading { display: grid; gap: 3px; }
.card-heading h2, .card-heading p { margin: 0; }
.eyebrow { color: var(--color-primary); font-weight: 800; font-size: .76rem; letter-spacing: .08em; text-transform: uppercase; }
.summary-copy { margin: 0; font-size: 1.05rem; line-height: 1.8; white-space: pre-wrap; }
.empty-copy, .muted-line { color: var(--color-text-muted); }
.chip-list { display: flex; gap: 8px; flex-wrap: wrap; }
.profile-chip { display: inline-flex; gap: 5px; align-items: center; padding: 7px 11px; border-radius: 999px; background: color-mix(in srgb, var(--color-primary) 11%, var(--color-bg-subtle)); font-weight: 700; }
.chip-evidence, .evidence-link, .drawer-close { border: 0; color: var(--color-primary); background: transparent; cursor: pointer; }
.chip-evidence { padding: 0 1px; font: inherit; }
.evidence-link { justify-self: start; padding: 0; font-weight: 700; }
.evidence-backdrop { position: fixed; inset: 0; z-index: 40; display: flex; justify-content: flex-end; background: rgba(0, 0, 0, .28); }
.evidence-drawer { width: min(430px, 92vw); height: 100%; box-sizing: border-box; padding: 24px; overflow: auto; background: var(--color-surface); box-shadow: -12px 0 40px rgba(0, 0, 0, .16); }
.drawer-heading { display: flex; justify-content: space-between; gap: 18px; align-items: flex-start; }
.drawer-heading h2 { margin: 4px 0 0; }
.drawer-close { font-size: 1.8rem; line-height: 1; }
.evidence-excerpt { line-height: 1.75; white-space: pre-wrap; }
.evidence-list { display: grid; gap: 14px; margin-top: 18px; }
.evidence-item { padding: 15px; border: 1px solid var(--color-border); border-radius: 14px; background: var(--color-bg-subtle); }
.evidence-item h3 { margin: 0; }
.evidence-open { margin-top: 6px; }
.evidence-error { color: #b3261e; }
.hero-related { display: flex; flex-wrap: wrap; gap: 6px; }
.intent-grid, .growth-grid, .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.intent-grid div { padding: 12px; border-radius: 12px; background: var(--color-bg-subtle); }
.intent-grid dt { color: var(--color-text-muted); font-size: .82rem; }
.intent-grid dd { margin: 5px 0 0; font-weight: 700; }
.growth-grid > div { padding: 14px; border-radius: 14px; background: var(--color-bg-subtle); }
.growth-grid h3 { margin-top: 0; }
.growth-grid ul { margin-bottom: 0; padding-left: 20px; }
label { display: grid; gap: 7px; color: var(--color-text-muted); font-size: .86rem; font-weight: 700; }
input, textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--color-border); border-radius: 11px; padding: 10px 12px; color: var(--color-text); background: var(--color-bg-subtle); font: inherit; resize: vertical; }
.state-card { padding: 24px; border: 1px solid var(--color-border); border-radius: 16px; background: var(--color-surface); }
.state-card.error { border-color: color-mix(in srgb, #b3261e 40%, var(--color-border)); }
@media (max-width: 760px) { .profile-hero { flex-direction: column; } .hero-actions { justify-content: flex-start; } .profile-grid, .intent-grid, .growth-grid, .form-grid { grid-template-columns: 1fr; } .span-2 { grid-column: span 1; } }
</style>
