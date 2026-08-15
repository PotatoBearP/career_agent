const CAREER_AGENT_API_BASE_PATH = '/api/career-agent';

export const CAREER_AGENT_API_ROUTE_PATTERNS = {
  createThread: `${CAREER_AGENT_API_BASE_PATH}/threads`,
  listThreads: `${CAREER_AGENT_API_BASE_PATH}/threads`,
  thread: `${CAREER_AGENT_API_BASE_PATH}/threads/:threadId`,
  threadMessages: `${CAREER_AGENT_API_BASE_PATH}/threads/:threadId/messages`,
  threadMessagesStream: `${CAREER_AGENT_API_BASE_PATH}/threads/:threadId/messages/stream`,
  threadToolResponse: `${CAREER_AGENT_API_BASE_PATH}/threads/:threadId/tool-responses/:toolUseId`,
  threadFiles: `${CAREER_AGENT_API_BASE_PATH}/threads/:threadId/files`,
  threadFile: `${CAREER_AGENT_API_BASE_PATH}/threads/:threadId/files/:fileName`,
  profile: `${CAREER_AGENT_API_BASE_PATH}/profile`,
  profileProduct: `${CAREER_AGENT_API_BASE_PATH}/profile/product`,
  profileRefreshJobs: `${CAREER_AGENT_API_BASE_PATH}/profile/refresh-jobs`,
  profileRefreshJobCurrent: `${CAREER_AGENT_API_BASE_PATH}/profile/refresh-jobs/current`,
  profileRefreshJob: `${CAREER_AGENT_API_BASE_PATH}/profile/refresh-jobs/:jobId`,
  profileEvidence: `${CAREER_AGENT_API_BASE_PATH}/profile/evidence/:evidenceRef`,
  profileEvidenceNavigation: `${CAREER_AGENT_API_BASE_PATH}/profile/evidence/:evidenceRef/navigation`,
  profileSuggestions: `${CAREER_AGENT_API_BASE_PATH}/profile/suggestions`,
  profileBase: `${CAREER_AGENT_API_BASE_PATH}/profile/base`,
  profileState: `${CAREER_AGENT_API_BASE_PATH}/profile/state`,
  profileMemories: `${CAREER_AGENT_API_BASE_PATH}/profile/memories`,
  profileMemory: `${CAREER_AGENT_API_BASE_PATH}/profile/memories/:memoryId`,
  profileMemoryByIndex: `${CAREER_AGENT_API_BASE_PATH}/profile/memories/by-index/:profileIndex`,
  profileProposals: `${CAREER_AGENT_API_BASE_PATH}/profile/proposals`,
  profileProposalAction: `${CAREER_AGENT_API_BASE_PATH}/profile/proposals/:proposalId/:action`,
  profileHistory: `${CAREER_AGENT_API_BASE_PATH}/profile/history`,
  listArtifacts: `${CAREER_AGENT_API_BASE_PATH}/artifacts`,
  artifact: `${CAREER_AGENT_API_BASE_PATH}/artifacts/:artifactId`,
  refreshArtifact: `${CAREER_AGENT_API_BASE_PATH}/artifacts/:artifactId/refresh`,
  authSession: `${CAREER_AGENT_API_BASE_PATH}/auth/session`,
  authLogin: `${CAREER_AGENT_API_BASE_PATH}/auth/login`,
  authRegister: `${CAREER_AGENT_API_BASE_PATH}/auth/register`,
  authRefresh: `${CAREER_AGENT_API_BASE_PATH}/auth/refresh`,
  authLogout: `${CAREER_AGENT_API_BASE_PATH}/auth/logout`,
  praxisSsoTicket: `${CAREER_AGENT_API_BASE_PATH}/integrations/praxis/sso-ticket`,
  settings: `${CAREER_AGENT_API_BASE_PATH}/settings`,
  settingsUsername: `${CAREER_AGENT_API_BASE_PATH}/settings/username`,
  settingsApi: `${CAREER_AGENT_API_BASE_PATH}/settings/api`,
  settingsApiTest: `${CAREER_AGENT_API_BASE_PATH}/settings/api/test`,
  settingsMcpGithub: `${CAREER_AGENT_API_BASE_PATH}/settings/mcp/github`,
  settingsMcpGithubTest: `${CAREER_AGENT_API_BASE_PATH}/settings/mcp/github/test`,
} as const;

export const CAREER_AGENT_API_ROUTE_DESCRIPTORS = [
  {
    method: 'DELETE',
    path: CAREER_AGENT_API_ROUTE_PATTERNS.thread,
    purpose: '删除当前用户不再需要的会话。',
  },
  {
    method: 'GET',
    path: CAREER_AGENT_API_ROUTE_PATTERNS.listThreads,
    purpose: '按用户填充左侧会话导航栏。',
  },
  {
    method: 'POST',
    path: CAREER_AGENT_API_ROUTE_PATTERNS.createThread,
    purpose: '为当前用户创建新会话，并加入左侧导航。',
  },
  {
    method: 'GET',
    path: CAREER_AGENT_API_ROUTE_PATTERNS.threadMessages,
    purpose: '加载当前会话的消息时间线。',
  },
  {
    method: 'POST',
    path: CAREER_AGENT_API_ROUTE_PATTERNS.threadMessages,
    purpose: '向当前会话发送文本或带附件引用的消息。',
  },
  {
    method: 'POST',
    path: CAREER_AGENT_API_ROUTE_PATTERNS.threadToolResponse,
    purpose: '提交 AskUserQuestion 的答案并恢复当前 agent。',
  },
  {
    method: 'POST',
    path: CAREER_AGENT_API_ROUTE_PATTERNS.threadFiles,
    purpose: '向当前会话直传单个文件，并返回发送消息可引用的 asset id。',
  },
  {
    method: 'GET',
    path: CAREER_AGENT_API_ROUTE_PATTERNS.threadFile,
    purpose: '读取当前会话已经上传的文件流。',
  },
  {
    method: 'GET',
    path: CAREER_AGENT_API_ROUTE_PATTERNS.profile,
    purpose: '读取结构化画像正式数据。',
  },
  {
    method: 'PUT',
    path: CAREER_AGENT_API_ROUTE_PATTERNS.profile,
    purpose: '持久化前端显式提交的画像编辑。',
  },
  {
    method: 'GET/PATCH',
    path: CAREER_AGENT_API_ROUTE_PATTERNS.profileProduct,
    purpose: '读取或按聚合版本更新统一的职业与学习画像。',
  },
  {
    method: 'GET',
    path: CAREER_AGENT_API_ROUTE_PATTERNS.profileSuggestions,
    purpose: '加载与对话上下文关联的非破坏式画像建议。',
  },
  {
    method: 'GET/PATCH',
    path: CAREER_AGENT_API_ROUTE_PATTERNS.profileBase,
    purpose: '读取或按版本更新当前认证用户的基础 Profile V2。',
  },
  {
    method: 'GET/POST',
    path: CAREER_AGENT_API_ROUTE_PATTERNS.profileMemories,
    purpose: '查询或按 L1-L3 新增当前认证用户的 Profile Memory。',
  },
  {
    method: 'PUT',
    path: CAREER_AGENT_API_ROUTE_PATTERNS.profileMemoryByIndex,
    purpose: '按公开 profileIndex 替换当前认证用户的一条活动 Profile Memory。',
  },
  {
    method: 'GET',
    path: CAREER_AGENT_API_ROUTE_PATTERNS.profileProposals,
    purpose: '加载需要用户确认的 Profile 变更提案。',
  },
  {
    method: 'GET',
    path: CAREER_AGENT_API_ROUTE_PATTERNS.listArtifacts,
    purpose: '加载当前用户工件目录及其版本信息。',
  },
  {
    method: 'GET',
    path: CAREER_AGENT_API_ROUTE_PATTERNS.artifact,
    purpose: '在宿主面板中打开单个工件。',
  },
  {
    method: 'POST',
    path: CAREER_AGENT_API_ROUTE_PATTERNS.refreshArtifact,
    purpose: '请求新的工件版本。',
  },
  {
    method: 'GET',
    path: CAREER_AGENT_API_ROUTE_PATTERNS.settings,
    purpose: '加载设置页个人中心数据。',
  },
  {
    method: 'PATCH',
    path: CAREER_AGENT_API_ROUTE_PATTERNS.settingsUsername,
    purpose: '修改当前用户用户名与显示名称。',
  },
  {
    method: 'PUT',
    path: CAREER_AGENT_API_ROUTE_PATTERNS.settingsApi,
    purpose: '新增或更新当前用户的 Anthropic API 配置。',
  },
  {
    method: 'POST',
    path: CAREER_AGENT_API_ROUTE_PATTERNS.settingsApiTest,
    purpose: '测试当前或待保存的 API 配置连通性。',
  },
  {
    method: 'GET/PUT/DELETE',
    path: CAREER_AGENT_API_ROUTE_PATTERNS.settingsMcpGithub,
    purpose: '读取、保存或删除当前用户的 GitHub MCP 配置。',
  },
  {
    method: 'POST',
    path: CAREER_AGENT_API_ROUTE_PATTERNS.settingsMcpGithubTest,
    purpose: '测试已保存或待保存的 GitHub MCP PAT。',
  },
] as const;

export const CAREER_AGENT_API_ROUTES = {
  createThread() {
    return CAREER_AGENT_API_ROUTE_PATTERNS.createThread;
  },
  listThreads() {
    return CAREER_AGENT_API_ROUTE_PATTERNS.listThreads;
  },
  thread(threadId: string) {
    return CAREER_AGENT_API_ROUTE_PATTERNS.thread.replace(':threadId', encodeURIComponent(threadId));
  },
  threadMessages(threadId: string) {
    return CAREER_AGENT_API_ROUTE_PATTERNS.threadMessages.replace(':threadId', encodeURIComponent(threadId));
  },
  sendThreadMessage(threadId: string) {
    return CAREER_AGENT_API_ROUTE_PATTERNS.threadMessages.replace(':threadId', encodeURIComponent(threadId));
  },
  streamThreadMessage(threadId: string) {
    return CAREER_AGENT_API_ROUTE_PATTERNS.threadMessagesStream.replace(':threadId', encodeURIComponent(threadId));
  },
  threadToolResponse(threadId: string, toolUseId: string) {
    return CAREER_AGENT_API_ROUTE_PATTERNS.threadToolResponse
      .replace(':threadId', encodeURIComponent(threadId))
      .replace(':toolUseId', encodeURIComponent(toolUseId));
  },
  threadFiles(threadId: string) {
    return CAREER_AGENT_API_ROUTE_PATTERNS.threadFiles.replace(':threadId', encodeURIComponent(threadId));
  },
  threadFile(threadId: string, fileName: string) {
    return CAREER_AGENT_API_ROUTE_PATTERNS.threadFile
      .replace(':threadId', encodeURIComponent(threadId))
      .replace(':fileName', encodeURIComponent(fileName));
  },
  profile() {
    return CAREER_AGENT_API_ROUTE_PATTERNS.profile;
  },
  profileProduct() {
    return CAREER_AGENT_API_ROUTE_PATTERNS.profileProduct;
  },
  profileRefreshJobs() { return CAREER_AGENT_API_ROUTE_PATTERNS.profileRefreshJobs; },
  profileRefreshJobCurrent() { return CAREER_AGENT_API_ROUTE_PATTERNS.profileRefreshJobCurrent; },
  profileRefreshJob(jobId: string) {
    return CAREER_AGENT_API_ROUTE_PATTERNS.profileRefreshJob.replace(':jobId', encodeURIComponent(jobId));
  },
  profileEvidence(evidenceRef: string) {
    return CAREER_AGENT_API_ROUTE_PATTERNS.profileEvidence.replace(':evidenceRef', encodeURIComponent(evidenceRef));
  },
  profileEvidenceNavigation(evidenceRef: string) {
    return CAREER_AGENT_API_ROUTE_PATTERNS.profileEvidenceNavigation.replace(':evidenceRef', encodeURIComponent(evidenceRef));
  },
  profileSuggestions() {
    return CAREER_AGENT_API_ROUTE_PATTERNS.profileSuggestions;
  },
  profileBase() {
    return CAREER_AGENT_API_ROUTE_PATTERNS.profileBase;
  },
  profileState() {
    return CAREER_AGENT_API_ROUTE_PATTERNS.profileState;
  },
  profileMemories() {
    return CAREER_AGENT_API_ROUTE_PATTERNS.profileMemories;
  },
  profileMemory(memoryId: string) {
    return CAREER_AGENT_API_ROUTE_PATTERNS.profileMemory.replace(':memoryId', encodeURIComponent(memoryId));
  },
  profileMemoryByIndex(profileIndex: string) {
    return CAREER_AGENT_API_ROUTE_PATTERNS.profileMemoryByIndex.replace(':profileIndex', encodeURIComponent(profileIndex));
  },
  profileProposals() {
    return CAREER_AGENT_API_ROUTE_PATTERNS.profileProposals;
  },
  profileProposalAction(proposalId: string, action: 'accept' | 'reject') {
    return CAREER_AGENT_API_ROUTE_PATTERNS.profileProposalAction
      .replace(':proposalId', encodeURIComponent(proposalId))
      .replace(':action', action);
  },
  profileHistory() {
    return CAREER_AGENT_API_ROUTE_PATTERNS.profileHistory;
  },
  listArtifacts() {
    return CAREER_AGENT_API_ROUTE_PATTERNS.listArtifacts;
  },
  artifact(artifactId: string) {
    return CAREER_AGENT_API_ROUTE_PATTERNS.artifact.replace(':artifactId', encodeURIComponent(artifactId));
  },
  refreshArtifact(artifactId: string) {
    return CAREER_AGENT_API_ROUTE_PATTERNS.refreshArtifact.replace(':artifactId', encodeURIComponent(artifactId));
  },
  authSession() {
    return CAREER_AGENT_API_ROUTE_PATTERNS.authSession;
  },
  authLogin() {
    return CAREER_AGENT_API_ROUTE_PATTERNS.authLogin;
  },
  authRegister() {
    return CAREER_AGENT_API_ROUTE_PATTERNS.authRegister;
  },
  authRefresh() {
    return CAREER_AGENT_API_ROUTE_PATTERNS.authRefresh;
  },
  authLogout() {
    return CAREER_AGENT_API_ROUTE_PATTERNS.authLogout;
  },
  praxisSsoTicket() {
    return CAREER_AGENT_API_ROUTE_PATTERNS.praxisSsoTicket;
  },
  settings() {
    return CAREER_AGENT_API_ROUTE_PATTERNS.settings;
  },
  settingsUsername() {
    return CAREER_AGENT_API_ROUTE_PATTERNS.settingsUsername;
  },
  settingsApi() {
    return CAREER_AGENT_API_ROUTE_PATTERNS.settingsApi;
  },
  settingsApiTest() {
    return CAREER_AGENT_API_ROUTE_PATTERNS.settingsApiTest;
  },
  settingsMcpGithub() {
    return CAREER_AGENT_API_ROUTE_PATTERNS.settingsMcpGithub;
  },
  settingsMcpGithubTest() {
    return CAREER_AGENT_API_ROUTE_PATTERNS.settingsMcpGithubTest;
  },
} as const;
