const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  bootstrap: null,
  documents: { profile: "", scenario: "" },
  scenarioDocuments: {},
  selectedScenarioId: null,
  activeEditor: "profile",
  mode: "mock",
  result: null,
  selectedSkillId: null,
  runs: [],
  loadedRunId: null,
  selectedArtifactName: null,
  selectedArtifactFile: null,
  selectedTaskIteration: null,
  ioGraphScale: 1,
  ioGraphSize: { width: 0, height: 0 },
  currentPersist: true,
};

const stageOrder = ["input_validation", "task_synthesis", "task_tool_composition", "reference_render", "artifact_validation"];
const stageLabels = {
  input_validation: "输入检验",
  task_synthesis: "任务合成",
  task_tool_composition: "任务与工具组合",
  reference_render: "参考样式生成",
  artifact_validation: "产物校验",
};

let monitorStartedAt = null;
let monitorTimer = null;
let monitorHealthTimer = null;
let monitorEvents = [];
let monitorTotal = stageOrder.length;
let monitorLastHealth = null;

const labels = {
  profile: "用户画像（自然语言）",
  scenario: "业务场景（自然语言）",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message, error = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast show${error ? " error" : ""}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = "toast"; }, 3600);
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function syncEditor() {
  $("#editorLabel").textContent = labels[state.activeEditor];
  $("#jsonEditor").value = String(state.documents[state.activeEditor] || "");
  $("#scenarioSelectorWrap").classList.toggle("hidden", state.activeEditor !== "scenario");
  validateEditor();
}

function validateEditor() {
  const validity = $("#jsonValidity");
  const value = $("#jsonEditor").value.trim();
  if (value) {
    state.documents[state.activeEditor] = value;
    if (state.activeEditor === "scenario" && state.selectedScenarioId) {
      state.scenarioDocuments[state.selectedScenarioId] = value;
    }
    validity.textContent = "内容已填写";
    validity.className = "validity valid";
    return true;
  }
  validity.textContent = "内容不能为空";
  validity.className = "validity invalid";
  return false;
}

function validateAllInputs() {
  if (!validateEditor()) return false;
  return ["profile", "scenario"].every((name) => String(state.documents[name] || "").trim());
}

function handleInputEdit() {
  validateEditor();
  const original = state.result?.inputs?.[state.activeEditor];
  if (original !== undefined && String(original) !== String(state.documents[state.activeEditor])) {
    $("#skilltoolSynthesisButton").disabled = true;
    $("#taskIterationSummary").textContent = "画像或场景已修改，请重新合成任务后再生成 SkillTool。";
  }
}

function modelConfigFromForm() {
  const timeoutMinutes = Number($("#timeoutMinutes").value);
  return {
    base_url: $("#baseUrl").value.trim(),
    model: $("#modelName").value.trim(),
    api_key: $("#apiKey").value,
    temperature: Number($("#temperature").value || 0.2),
    max_tokens: Number($("#maxTokens").value || 6000),
    timeout_seconds: Math.round((Number.isFinite(timeoutMinutes) && timeoutMinutes > 0 ? timeoutMinutes : 5) * 60),
  };
}

function renderPipeline(runState = "idle") {
  if (!state.bootstrap) return;
  const completed = new Set();
  const stageMap = {
    input_validation: "inputs",
    task_synthesis: "tasks",
    candidate_synthesis: "composition",
  };
  if (state.result) {
    completed.add("profile");
    for (const stage of state.result.stages || []) completed.add(stageMap[stage.stage]);
    if (state.result.direct_synthesis?.enabled) {
      for (const id of ["composition", "render", "validation", "skilltools"]) completed.add(id);
    }
  }
  $("#pipelineFlow").innerHTML = state.bootstrap.pipeline.map((node, index) => {
    const status = completed.has(node.id) ? "complete" : runState === "running" && index === 1 ? "running" : "";
    const details = node.id === "profile"
      ? String(state.documents.profile || "画像文本").split(/\r?\n/)[0].slice(0, 42)
      : state.result
        ? nodeCount(node.id)
        : node.kind;
    return `<article class="flow-node ${status}">
      <span class="node-index">0${index + 1}</span>
      <strong>${escapeHtml(node.label)}</strong>
      <small>${escapeHtml(details)}</small>
    </article>`;
  }).join("");
}

function nodeCount(id) {
  const summary = state.result?.summary || {};
  if (id === "inputs") return `${state.result?.input_validation?.summary?.total || 0} assets`;
  if (id === "tasks") return `${summary.task_iterations || 0} rounds · ${summary.tasks || 0} tasks`;
  if (id === "composition") return `${summary.skilltools || state.result?.candidate_generation?.raw_count || 0} tasks + tools`;
  if (id === "render") return `${state.result?.artifacts?.length || 0} ref-style packages`;
  if (id === "validation") return directValidationPassed() ? "validated" : "pending";
  if (id === "skilltools") return `${summary.eligible_artifacts || 0} artifacts`;
  return "completed";
}

function documentPayload(name) {
  const value = state.documents[name];
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function qualitySummaryText(summary = {}) {
  if (summary.quality_status === "pending" || !summary.quality_status) return "待检测";
  if ((summary.failed_rubrics || 0) > 0) return `${summary.failed_rubrics} 项失败`;
  if ((summary.warning_rubrics || 0) > 0) return `${summary.warning_rubrics} 项警告`;
  return "通过";
}

function renderScenarioOptions() {
  const scenarios = state.bootstrap?.scenarios || [];
  const select = $("#scenarioSelect");
  select.innerHTML = scenarios.map((scenario) =>
    `<option value="${escapeHtml(scenario.scenario_id)}">${escapeHtml(scenario.name)}</option>`
  ).join("");
  if (state.selectedScenarioId && !scenarios.some((item) => item.scenario_id === state.selectedScenarioId)) {
    select.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(state.selectedScenarioId)}">自定义 / 历史场景</option>`);
  }
  select.value = state.selectedScenarioId || scenarios[0]?.scenario_id || "";
  const selected = scenarios.find((item) => item.scenario_id === select.value);
  $("#scenarioDescription").textContent = selected?.description || "该内容来自历史运行或用户编辑，可继续修改。";
}

function selectScenarioForContent(content) {
  const scenarios = state.bootstrap?.scenarios || [];
  const matched = scenarios.find((item) => String(item.content).trim() === String(content).trim());
  state.selectedScenarioId = matched?.scenario_id || "custom_scenario";
  state.scenarioDocuments[state.selectedScenarioId] = content;
  renderScenarioOptions();
}

function directStageRecords() {
  return (state.result?.direct_synthesis?.stages || []).map((stage) => {
    if (typeof stage !== "string") return stage;
    const normalized = stage === "ref_style_render" ? "reference_render" : stage;
    return { id: normalized, label: stageLabels[normalized] || normalized, status: "completed", detail: "历史直接合成记录" };
  });
}

function directValidationPassed() {
  const direct = state.result?.direct_synthesis;
  if (!direct?.enabled) return false;
  if (typeof direct.validation?.passed === "boolean") return direct.validation.passed;
  return Number(direct.artifact_count || 0) > 0 && Number(direct.artifact_count) === (state.result?.artifacts || []).length;
}

function formatDuration(durationMs) {
  const milliseconds = Math.max(0, Number(durationMs) || 0);
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function visibleStageRecords() {
  return [
    ...(state.result?.stages || []).filter((stage) => ["input_validation", "task_synthesis"].includes(stage.stage)),
    ...directStageRecords(),
  ];
}

function renderPersistedTiming() {
  if (!state.result || monitorTimer) return;
  const stages = visibleStageRecords();
  const total = Number(state.result.timing?.total_duration_ms) || stages.reduce((sum, stage) => sum + Number(stage.duration_ms || 0), 0);
  const completed = stages.filter((stage) => stage.status === "completed").length;
  const isComplete = state.result.run_status === "completed";
  $("#monitorStatus").textContent = isComplete ? "完成" : "已保存";
  $("#monitorStatus").className = `monitor-status ${isComplete ? "success" : ""}`;
  $("#monitorMessage").textContent = `总运行时间 ${formatDuration(total)}`;
  $("#monitorStage").textContent = state.result.timing?.completed_at
    ? `完成于 ${new Date(state.result.timing.completed_at).toLocaleString()}`
    : `下一工序：${stageLabels[state.result.next_stage] || state.result.next_stage || "无"}`;
  $("#monitorElapsed").textContent = formatDuration(total);
  $("#monitorProgressText").textContent = `${completed} / ${stages.length} stages`;
  $("#monitorProgressBar").style.width = `${stages.length ? (completed / stages.length) * 100 : 0}%`;
  monitorEvents = stages.map((stage) => ({
    time: "—",
    stage: stage.label || stageLabels[stage.stage || stage.id] || stage.stage || stage.id,
    message: `完成 · ${formatDuration(stage.duration_ms)}`,
    kind: "ok",
  }));
  renderMonitorEvents();
}

function renderStages() {
  const strip = $("#stageStrip");
  if (!state.result) { strip.innerHTML = ""; return; }
  const visibleStages = visibleStageRecords();
  strip.innerHTML = visibleStages.map((stage) =>
    `<span class="stage-chip ${escapeHtml(stage.status)}">${escapeHtml(stage.label || stageLabels[stage.stage || stage.id] || stage.stage)} · ${escapeHtml(stage.status)}${stage.duration_ms == null ? "" : ` · ${formatDuration(stage.duration_ms)}`}</span>`
  ).join("");
  const total = Number(state.result.timing?.total_duration_ms) || visibleStages.reduce((sum, stage) => sum + Number(stage.duration_ms || 0), 0);
  $("#runMeta").textContent = `${state.result.run_id} · ${state.result.model_name || state.result.model_mode} · ${formatDuration(total)}`;
}

function monitorElapsedText() {
  const seconds = monitorStartedAt ? Math.floor((Date.now() - monitorStartedAt) / 1000) : 0;
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function renderMonitorEvents() {
  const log = $("#monitorLog");
  log.innerHTML = monitorEvents.length ? monitorEvents.map((event) => `<div class="monitor-event">
    <time>${escapeHtml(event.time)}</time><span class="${event.kind === "error" ? "event-error" : event.kind === "ok" ? "event-ok" : ""}">${escapeHtml(event.stage)}</span><span>${escapeHtml(event.message)}</span>
  </div>`).join("") : "<p>运行事件会实时显示在这里。</p>";
  log.scrollTop = log.scrollHeight;
}

function monitorEvent(stage, message, kind = "info") {
  monitorEvents.push({ time: new Date().toLocaleTimeString(), stage: stageLabels[stage] || stage, message, kind });
  renderMonitorEvents();
}

async function checkMonitorHealth() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    $("#monitorHealth").textContent = "服务状态：在线";
    if (monitorLastHealth === false) monitorEvent("服务", "本地合成服务已恢复", "ok");
    monitorLastHealth = true;
  } catch (error) {
    $("#monitorHealth").textContent = "服务状态：连接失败";
    if (monitorLastHealth !== false) monitorEvent("服务", `心跳失败：${error.message}`, "error");
    monitorLastHealth = false;
  }
}

function startMonitor(total, message) {
  clearInterval(monitorTimer);
  clearInterval(monitorHealthTimer);
  monitorStartedAt = Date.now();
  monitorTotal = total;
  monitorEvents = [];
  monitorLastHealth = null;
  $("#monitorStatus").textContent = "运行中";
  $("#monitorStatus").className = "monitor-status running";
  $("#monitorMessage").textContent = message;
  $("#monitorStage").textContent = "正在准备请求";
  $("#monitorProgressText").textContent = `0 / ${total} stages`;
  $("#monitorProgressBar").style.width = "0%";
  $("#monitorElapsed").textContent = "00:00";
  renderMonitorEvents();
  monitorTimer = setInterval(() => { $("#monitorElapsed").textContent = monitorElapsedText(); }, 250);
  checkMonitorHealth();
  monitorHealthTimer = setInterval(checkMonitorHealth, 2000);
}

function monitorStageStarted(stage, completed) {
  $("#monitorStage").textContent = `正在执行：${stageLabels[stage] || stage}`;
  $("#monitorProgressText").textContent = `${completed} / ${monitorTotal} stages`;
  $("#monitorProgressBar").style.width = `${(completed / monitorTotal) * 100}%`;
  monitorEvent(stage, "请求已发送，等待阶段结果");
}

function monitorStageCompleted(stage, completed, durationMs) {
  $("#monitorProgressText").textContent = `${completed} / ${monitorTotal} stages`;
  $("#monitorProgressBar").style.width = `${(completed / monitorTotal) * 100}%`;
  monitorEvent(stage, `完成 · ${formatDuration(durationMs)} · 已保存阶段快照`, "ok");
}

function finishMonitor(success, message) {
  clearInterval(monitorTimer);
  clearInterval(monitorHealthTimer);
  monitorTimer = null;
  monitorHealthTimer = null;
  $("#monitorElapsed").textContent = monitorElapsedText();
  $("#monitorStatus").textContent = success ? "完成" : "异常";
  $("#monitorStatus").className = `monitor-status ${success ? "success" : "error"}`;
  $("#monitorStage").textContent = success ? "全部请求已完成" : "运行已停止";
  $("#monitorMessage").textContent = message;
  if (!success) monitorEvent("错误", message, "error");
}

function renderArtifacts() {
  const artifacts = state.result?.artifacts || [];
  const list = $("#artifactList");
  $("#artifactCount").textContent = `${artifacts.length} 个`;
  const location = state.result?.run_directory
    ? `${state.result.run_directory}\\generated-skills`
    : state.result?.run_id
      ? `runs/${state.result.run_id}/generated-skills`
      : "通过直接产物校验的 SkillTool 与 Harness Tool 文件";
  $("#artifactLocation").textContent = location;
  if (!artifacts.length) {
    list.className = "artifact-list empty";
    list.innerHTML = "<p>没有通过产物校验的生成文件。</p>";
    $("#artifactFileTabs").innerHTML = "";
    $("#artifactFileContent").textContent = "没有可检查的产物文件。";
    return;
  }
  if (!artifacts.some((item) => item.skill_name === state.selectedArtifactName)) state.selectedArtifactName = artifacts[0].skill_name;
  list.className = "artifact-list";
  list.innerHTML = artifacts.map((artifact) => `<button class="artifact-card ${artifact.skill_name === state.selectedArtifactName ? "active" : ""}" data-artifact-name="${escapeHtml(artifact.skill_name)}">
    <strong>${escapeHtml(artifact.skill_name)}</strong>
    <small>${Object.keys(artifact.files || {}).length} files</small>
  </button>`).join("");
  $$(".artifact-card").forEach((button) => button.addEventListener("click", () => {
    state.selectedArtifactName = button.dataset.artifactName;
    state.selectedArtifactFile = null;
    renderArtifacts();
  }));
  const artifact = artifacts.find((item) => item.skill_name === state.selectedArtifactName) || artifacts[0];
  const fileNames = Object.keys(artifact.files || {});
  if (!fileNames.includes(state.selectedArtifactFile)) state.selectedArtifactFile = fileNames[0] || null;
  $("#artifactFileTabs").innerHTML = fileNames.map((name) => `<button class="artifact-file-tab ${name === state.selectedArtifactFile ? "active" : ""}" data-file-name="${escapeHtml(name)}">${escapeHtml(name)}</button>`).join("");
  $$(".artifact-file-tab").forEach((button) => button.addEventListener("click", () => {
    state.selectedArtifactFile = button.dataset.fileName;
    renderArtifacts();
  }));
  const content = artifact.files?.[state.selectedArtifactFile];
  $("#artifactFileContent").textContent = typeof content === "string" ? content : formatJson(content);
}

function graphKey(value) {
  return String(value || "unnamed").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function graphLabel(value, limit = 27) {
  const text = String(value || "unnamed");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function applyIoGraphScale() {
  const graph = $("#ioOverviewGraph");
  const { width, height } = state.ioGraphSize;
  graph.style.width = `${width * state.ioGraphScale}px`;
  graph.style.height = `${height * state.ioGraphScale}px`;
  $("#ioZoomReset").textContent = `${Math.round(state.ioGraphScale * 100)}%`;
}

function renderGlobalIoGraph() {
  const candidates = state.result?.final_candidates || [];
  const inventoryItems = state.result?.task_map?.input_inventory || [];
  const inventory = new Map(inventoryItems.map((item) => [graphKey(item.asset_id), item]));
  const graph = $("#ioOverviewGraph");
  if (!candidates.length) {
    state.ioGraphSize = { width: 900, height: 640 };
    graph.setAttribute("viewBox", "0 0 900 640");
    graph.innerHTML = '<text x="450" y="320" text-anchor="middle" class="graph-node-subtitle">等待 SkillTool 候选数据</text>';
    $("#ioOverviewStats").innerHTML = "<span>等待合成结果</span>";
    applyIoGraphScale();
    return;
  }

  const dataNodes = new Map();
  const skills = new Map();
  const ensureData = (name, metadata = {}) => {
    const key = graphKey(name);
    if (!dataNodes.has(key)) dataNodes.set(key, { key, name: metadata.name || name, source: metadata.source, producer: metadata.producer, availability: metadata.availability, producers: [], consumers: [] });
    const data = dataNodes.get(key);
    if (metadata.name) data.name = metadata.name;
    if (metadata.source) data.source = metadata.source;
    if (metadata.producer) data.producer = metadata.producer;
    if (metadata.availability) data.availability = metadata.availability;
    return data;
  };
  for (const item of inventoryItems) ensureData(item.asset_id, item);
  for (const candidate of candidates) {
    const skillId = String(candidate.skill_id || candidate.tool_name);
    const skill = {
      id: skillId,
      title: candidate.title || candidate.tool_name || skillId,
      inputs: [],
      requiredDependencyInputs: [],
      outputs: [],
    };
    for (const [name, field] of Object.entries(candidate.input_schema || {})) {
      const reference = field.source_ref || name;
      const asset = inventory.get(graphKey(reference));
      const data = ensureData(reference, asset || { name, source: field.source, availability: field.available ? "available" : "conditional", producer: { kind: field.acquisition?.mode, name: field.acquisition?.provider } });
      data.consumers.push({ skillId, port: name });
      skill.inputs.push(data.key);
      if (field.source === "prior_skill_output" && field.required) skill.requiredDependencyInputs.push(data.key);
    }
    for (const name of Object.keys(candidate.output_schema || {})) {
      const data = ensureData(name);
      data.producers.push({ skillId, port: name });
      skill.outputs.push(data.key);
    }
    skills.set(skillId, skill);
  }

  const skillLevels = new Map();
  const resolveSkillLevel = (skillId, visiting = new Set()) => {
    if (skillLevels.has(skillId)) return skillLevels.get(skillId);
    if (visiting.has(skillId)) return 1;
    const nextVisiting = new Set(visiting).add(skillId);
    const skill = skills.get(skillId);
    let inputLevel = 0;
    for (const key of skill.requiredDependencyInputs) {
      const data = dataNodes.get(key);
      for (const producer of data.producers) {
        if (producer.skillId !== skillId) inputLevel = Math.max(inputLevel, resolveSkillLevel(producer.skillId, nextVisiting) + 1);
      }
    }
    const level = inputLevel + 1;
    skillLevels.set(skillId, level);
    return level;
  };
  for (const skillId of skills.keys()) resolveSkillLevel(skillId);

  const levels = new Map();
  const addAtLevel = (level, node) => {
    if (!levels.has(level)) levels.set(level, []);
    levels.get(level).push(node);
  };
  for (const data of dataNodes.values()) {
    const level = data.producers.length ? Math.max(...data.producers.map((item) => (skillLevels.get(item.skillId) || 1) + 1)) : 0;
    addAtLevel(level, { type: "data", id: data.key, data });
  }
  for (const skill of skills.values()) addAtLevel(skillLevels.get(skill.id) || 1, { type: "skill", id: skill.id, data: skill });
  for (const nodes of levels.values()) nodes.sort((a, b) => a.data.name?.localeCompare?.(b.data.name) || a.data.title?.localeCompare?.(b.data.title) || 0);

  const maxLevel = Math.max(...levels.keys());
  const maxNodes = Math.max(...[...levels.values()].map((items) => items.length));
  const width = Math.max(1100, (maxLevel + 1) * 245 + 80);
  const height = Math.max(680, maxNodes * 92 + 130);
  const positions = new Map();
  for (let level = 0; level <= maxLevel; level += 1) {
    const nodes = levels.get(level) || [];
    const startY = 65 + ((maxNodes - nodes.length) * 92) / 2;
    nodes.forEach((node, index) => {
      const isSkill = node.type === "skill";
      positions.set(`${node.type}:${node.id}`, { x: 35 + level * 245, y: startY + index * 92, width: isSkill ? 190 : 180, height: 58 });
    });
  }

  const edges = [];
  for (const data of dataNodes.values()) {
    const sourceData = positions.get(`data:${data.key}`);
    for (const consumer of data.consumers) {
      const target = positions.get(`skill:${consumer.skillId}`);
      if (!sourceData || !target) continue;
      const reused = data.consumers.length > 1;
      const duplicate = data.producers.length > 1;
      const x1 = sourceData.x + sourceData.width, y1 = sourceData.y + sourceData.height / 2;
      const x2 = target.x, y2 = target.y + target.height / 2;
      const bend = Math.max(35, Math.abs(x2 - x1) * 0.45);
      edges.push(`<path class="graph-edge ${duplicate ? "duplicate" : reused ? "reused" : ""}" d="M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}" marker-end="url(#graphArrow)"/>`);
    }
    for (const producer of data.producers) {
      const source = positions.get(`skill:${producer.skillId}`);
      const targetData = positions.get(`data:${data.key}`);
      if (!source || !targetData) continue;
      const duplicate = data.producers.length > 1;
      const reused = data.consumers.length > 1;
      const x1 = source.x + source.width, y1 = source.y + source.height / 2;
      const x2 = targetData.x, y2 = targetData.y + targetData.height / 2;
      const bend = Math.max(35, Math.abs(x2 - x1) * 0.45);
      edges.push(`<path class="graph-edge ${duplicate ? "duplicate" : reused ? "reused" : ""}" d="M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}" marker-end="url(#graphArrow)"/>`);
    }
  }

  const nodesMarkup = [];
  for (const [key, position] of positions) {
    const [type, ...idParts] = key.split(":");
    const id = idParts.join(":");
    if (type === "skill") {
      const skill = skills.get(id);
      nodesMarkup.push(`<g class="graph-skill-node" transform="translate(${position.x} ${position.y})"><title>${escapeHtml(skill.title)}\n${escapeHtml(skill.id)}</title><rect width="${position.width}" height="${position.height}" rx="7"/><text x="10" y="23" class="graph-node-title">${escapeHtml(graphLabel(skill.title))}</text><text x="10" y="42" class="graph-node-subtitle">${skill.inputs.length} inputs · ${skill.outputs.length} outputs</text></g>`);
    } else {
      const data = dataNodes.get(id);
      const duplicate = data.producers.length > 1;
      const reused = data.consumers.length > 1;
      const sourceClass = data.source === "upstream_artifact" || data.source === "ordinary_tool_output" ? "upstream" : data.source === "user_input" ? "user" : "external";
      const baseClass = data.producers.length ? "produced" : sourceClass;
      const nodeClass = `${baseClass}${reused ? " reused" : ""}${duplicate ? " duplicate" : ""}`;
      const upstreamProducer = [data.producer?.kind, data.producer?.name].filter(Boolean).join(" / ") || data.source || "external input";
      const detail = `${data.producers.length ? `${data.producers.length} SkillTool producer` : upstreamProducer} · ${data.consumers.length} consumer${data.consumers.length === 1 ? "" : "s"}`;
      const producerNames = data.producers.map((item) => item.skillId).join(", ") || upstreamProducer;
      nodesMarkup.push(`<g class="graph-data-node ${nodeClass}" transform="translate(${position.x} ${position.y})"><title>${escapeHtml(data.name)}\n来源：${escapeHtml(data.source || "skilltool_output")}\n生产者：${escapeHtml(producerNames)}\n消费者：${escapeHtml(data.consumers.map((item) => item.skillId).join(", ") || "最终输出")}</title><rect width="${position.width}" height="${position.height}" rx="18"/><text x="12" y="23" class="graph-node-title">${escapeHtml(graphLabel(data.name))}</text><text x="12" y="42" class="graph-node-subtitle">${escapeHtml(graphLabel(detail, 32))}</text></g>`);
    }
  }
  const levelLabels = [...levels.keys()].map((level) => `<text x="${35 + level * 245}" y="34" class="graph-level-label">${level % 2 === 0 ? "DATA" : "SKILLTOOLS"} · L${level}</text>`).join("");
  graph.setAttribute("viewBox", `0 0 ${width} ${height}`);
  graph.innerHTML = `<defs><style>
    .graph-edge{fill:none;stroke:#94a3b8;stroke-width:1.5;opacity:.72}.graph-edge.reused{stroke:#f59e0b;stroke-width:2.5;opacity:.9}.graph-edge.duplicate{stroke:#dc2626;stroke-width:2.5;opacity:.9}
    .graph-data-node rect{fill:#fff;stroke:#94a3b8;stroke-width:1.5}.graph-data-node.external rect{fill:#f8fafc;stroke:#64748b}.graph-data-node.upstream rect{fill:#f5f3ff;stroke:#7c3aed}.graph-data-node.user rect{fill:#f0fdfa;stroke:#0f766e}.graph-data-node.produced rect{fill:#eff6ff;stroke:#2563eb}.graph-data-node.reused rect{stroke-width:3;stroke-dasharray:7 3}.graph-data-node.duplicate rect{fill:#fef2f2;stroke:#dc2626;stroke-width:2.5;stroke-dasharray:none}.graph-skill-node rect{fill:#f7faff;stroke:#2563eb;stroke-width:2}.graph-node-title{font:600 11px system-ui,sans-serif;fill:#202124}.graph-node-subtitle{font:9px system-ui,sans-serif;fill:#68707a}.graph-level-label{font:600 10px system-ui,sans-serif;fill:#68707a;letter-spacing:.04em}
  </style><marker id="graphArrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="#64748b"/></marker></defs>${levelLabels}${edges.join("")}${nodesMarkup.join("")}`;
  state.ioGraphSize = { width, height };
  const upstreamCount = [...dataNodes.values()].filter((item) => ["upstream_artifact", "ordinary_tool_output"].includes(item.source)).length;
  const userInputCount = [...dataNodes.values()].filter((item) => item.source === "user_input").length;
  const acquiredCount = [...dataNodes.values()].filter((item) => item.source === "external_data").length;
  const reusedCount = [...dataNodes.values()].filter((item) => item.consumers.length > 1).length;
  const duplicateCount = [...dataNodes.values()].filter((item) => item.producers.length > 1).length;
  const topology = state.result?.quality?.topology || {};
  $("#ioOverviewStats").innerHTML = `<span><strong>${skills.size}</strong> SkillTools</span><span><strong>${dataNodes.size}</strong> 数据节点</span><span><strong>${upstreamCount}</strong> 前序产物</span><span><strong>${userInputCount}</strong> 用户输入</span><span><strong>${acquiredCount}</strong> 外部获取</span><span><strong>${reusedCount}</strong> 复用数据</span><span><strong>${duplicateCount}</strong> 重复输出</span><span><strong>${edges.length}</strong> 条连接</span><span><strong>${Math.round((topology.standalone_ratio || 0) * 100)}%</strong> 独立调用</span><span><strong>${topology.root_count ?? "—"}</strong> 根节点</span><span><strong>${topology.max_required_dependency_depth ?? "—"}</strong> 必需依赖深度</span>`;
  applyIoGraphScale();
}

function changeIoGraphScale(delta) {
  state.ioGraphScale = Math.min(2, Math.max(0.35, Math.round((state.ioGraphScale + delta) * 100) / 100));
  applyIoGraphScale();
}

function downloadIoGraph() {
  const graph = $("#ioOverviewGraph");
  const source = new XMLSerializer().serializeToString(graph);
  const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${state.result?.run_id || "skilltool"}-io-map.svg`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function qualityReport(skillId) {
  const report = (state.result?.quality?.candidate_reports || []).find((item) => item.skill_id === skillId);
  if (report) return report;
  if (directValidationPassed()) return { passed: true, status: "pass", rubrics: [], issues: [] };
  return { passed: false, status: "pending", rubrics: [], issues: [] };
}

function reportStatus(report) {
  if (!report || report.status === "pending") return { status: "pending", label: "待检测" };
  if (!report.passed) return { status: "fail", label: "需修改" };
  if ((report.rubrics || []).some((item) => item.status === "warning")) return { status: "warning", label: "有警告" };
  return { status: "pass", label: "通过" };
}

function renderQualityRubrics() {
  const quality = state.result?.quality;
  const container = $("#qualityRubrics");
  const badge = $("#qualityGateBadge");
  if (!quality?.rubrics?.length) {
    const direct = state.result?.direct_synthesis;
    if (direct?.enabled) {
      const validation = direct.validation || { passed: directValidationPassed(), errors: [] };
      container.className = "rubric-grid";
      container.innerHTML = directStageRecords().map((stage) => `<article class="rubric-card ${stage.status === "completed" ? "pass" : "pending"}"><header><strong>${escapeHtml(stage.label)}</strong><span>${stage.status === "completed" ? "完成" : "待处理"}</span></header><p>${escapeHtml(stage.detail)}</p></article>`).join("");
      badge.textContent = validation.passed ? "产物校验通过" : `${validation.errors?.length || 0} 项错误`;
      badge.className = `rubric-status ${validation.passed ? "pass" : "fail"}`;
    } else {
      container.className = "rubric-grid empty";
      container.innerHTML = "<p>完成直接合成后，将显示任务—工具组合、参考生成和产物校验结果。</p>";
      badge.textContent = "待校验";
      badge.className = "rubric-status pending";
    }
    return;
  }
  const summary = quality.rubric_summary || {};
  badge.textContent = summary.failed ? `${summary.failed} 项失败` : summary.warnings ? `${summary.warnings} 项警告` : "全部通过";
  badge.className = `rubric-status ${summary.failed ? "fail" : summary.warnings ? "warning" : "pass"}`;
  container.className = "rubric-grid";
  container.innerHTML = quality.rubrics.map((rubric) => {
    const affected = rubric.affected_skills?.length ? `<small>涉及：${rubric.affected_skills.map(escapeHtml).join(" · ")}</small>` : "";
    return `<article class="rubric-card ${escapeHtml(rubric.status)}">
      <header><strong>${escapeHtml(rubric.label)}</strong><span>${rubric.status === "pass" ? "通过" : rubric.status === "warning" ? "警告" : "失败"}</span></header>
      <p>${escapeHtml(rubric.summary)}</p>${affected}
      <details><summary>检查证据</summary><pre>${escapeHtml(formatJson(rubric.evidence || { issue_count: rubric.issues?.length || 0 }))}</pre></details>
    </article>`;
  }).join("");
}

function renderCandidates() {
  const container = $("#candidateList");
  const candidates = state.result?.final_candidates || [];
  if (!candidates.length) {
    container.className = "candidate-list empty-state";
    container.innerHTML = "<p>没有生成可用候选。</p>";
    return;
  }
  container.className = "candidate-list";
  container.innerHTML = candidates.map((candidate) => {
    const report = qualityReport(candidate.skill_id);
    const visualStatus = reportStatus(report);
    const active = candidate.skill_id === state.selectedSkillId ? "active" : "";
    const tools = candidate.tool_selection?.length
      ? candidate.tool_selection.map((item) => `${item.tool_name} · ${item.usage_mode}`)
      : ["不使用辅助工具"];
    return `<article class="candidate-card ${active}" data-skill-id="${escapeHtml(candidate.skill_id)}">
      <header><div><h3>${escapeHtml(candidate.title)}</h3><span class="subtle">${escapeHtml(candidate.tool_name)}</span></div><span class="rubric-status ${visualStatus.status}">${visualStatus.label}</span></header>
      <p>${escapeHtml(candidate.business_goal)}</p>
      <footer>${tools.map((tool) => `<span class="tag">${escapeHtml(tool)}</span>`).join("")}</footer>
    </article>`;
  }).join("");
  $$(".candidate-card").forEach((card) => card.addEventListener("click", () => {
    state.selectedSkillId = card.dataset.skillId;
    renderCandidates();
    renderInspector();
  }));
}

function renderInspector() {
  const candidate = (state.result?.final_candidates || []).find((item) => item.skill_id === state.selectedSkillId);
  if (!candidate) {
    $("#inspectorTitle").textContent = "输入 / 输出 / 工具";
    $("#qualityBadge").textContent = "—";
    $("#qualityBadge").className = "badge";
    $("#ioGraph").className = "empty";
    $("#ioGraph").innerHTML = "<p>选择一个 SkillTool。</p>";
    $("#toolPolicy").innerHTML = "";
    $("#harnessToolPolicy").innerHTML = "";
    $("#skillDetails").innerHTML = "";
    $("#candidateTemplate").textContent = "";
    return;
  }
  const report = qualityReport(candidate.skill_id);
  const visualStatus = reportStatus(report);
  $("#inspectorTitle").textContent = candidate.title;
  const badge = $("#qualityBadge");
  badge.textContent = visualStatus.label;
  badge.className = `rubric-status ${visualStatus.status}`;
  const inputs = Object.entries(candidate.input_schema || {});
  const outputs = Object.entries(candidate.output_schema || {});
  const tools = candidate.child_tools?.length ? candidate.child_tools.join(" · ") : "无辅助工具";
  $("#ioGraph").className = "io-graph";
  $("#ioGraph").innerHTML = `<div class="io-layout">
    <div class="io-column"><h4>INPUTS</h4>${inputs.map(([name, field]) => `<div class="io-node ${field.available ? "" : "unavailable"}"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(field.source)}${field.source_ref ? ` → ${escapeHtml(field.source_ref)}` : ""} · ${escapeHtml(field.type)}${field.required ? " · required" : ""}</small><small>${escapeHtml(field.description)}</small>${field.acquisition?.mode ? `<small>供应：${escapeHtml(field.acquisition.mode)}${field.acquisition.provider ? ` / ${escapeHtml(field.acquisition.provider)}` : ""}</small>` : ""}</div>`).join("")}</div>
    <div class="io-arrow">→</div>
    <div class="io-core"><strong>${escapeHtml(candidate.tool_name)}</strong><small>外部模型子上下文</small><div class="consumer-list">${escapeHtml(tools)}</div></div>
    <div class="io-arrow">→</div>
    <div class="io-column"><h4>OUTPUTS</h4>${outputs.map(([name, field]) => `<div class="io-node"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(field.type)}</small><small>${escapeHtml(field.description)}</small></div>`).join("")}<div class="consumer-list">消费方：${(candidate.output_consumers || []).map(escapeHtml).join(" · ")}</div></div>
  </div>`;
  const issues = report.issues?.length ? report.issues.map((item) => item.message).join("；") : "直接产物校验通过";
  const selections = candidate.tool_selection || [];
  $("#toolPolicy").className = "tool-policy";
  $("#toolPolicy").innerHTML = `<h3>辅助工具策略</h3>${selections.length ? selections.map((item) => `<div class="tool-row">
    <strong>${escapeHtml(item.tool_name)}</strong><span class="usage">${escapeHtml(item.usage_mode)}</span>
    <div><div>${escapeHtml(item.reason)}</div>${item.condition ? `<small>条件：${escapeHtml(item.condition)}</small>` : ""}${item.fallback ? `<small>降级：${escapeHtml(item.fallback)}</small>` : ""}</div>
  </div>`).join("") : "<p>无需辅助工具：仅分析已提供输入。</p>"}`;
  const harnessTools = candidate.harness_tools || [];
  $("#harnessToolPolicy").className = "harness-tool-policy";
  $("#harnessToolPolicy").innerHTML = `<h3>Harness 简单工具工序</h3>${harnessTools.length ? harnessTools.map((tool) => `<article class="harness-tool-card">
    <header><strong>${escapeHtml(tool.tool_name)}</strong><span class="usage">${tool.phase === "before_skill" ? "Skill 前" : "Skill 后"}</span></header>
    <p>${escapeHtml(tool.purpose)}</p><small>触发：${escapeHtml(tool.trigger)}</small>
    <ol>${(tool.steps || []).map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>
    <details><summary>输入 / 输出契约</summary><pre>${escapeHtml(formatJson({ input: tool.input || {}, output: tool.output || {}, read_only: tool.read_only }))}</pre></details>
  </article>`).join("") : "<p>无需新增 Harness Tool；该能力可直接调用 Skill，生命周期由通用 Harness 处理。</p>"}`;
  const harnessFlow = [
    "解析 Action Tool 输入",
    ...harnessTools.filter((tool) => tool.phase === "before_skill").map((tool) => tool.tool_name),
    candidate.tool_name,
    ...harnessTools.filter((tool) => tool.phase === "after_skill").map((tool) => tool.tool_name),
    "ReturnSkillResult",
  ];
  $("#skillDetails").innerHTML = `
    <div class="detail-block"><strong>执行工序</strong><p>${harnessFlow.map(escapeHtml).join(" → ")}</p></div>
    <div class="detail-block"><strong>场景绑定</strong><p>${escapeHtml(candidate.scenario_binding?.domain_mode)} · domain from ${escapeHtml(candidate.scenario_binding?.domain_source)} · profile ${escapeHtml(candidate.scenario_binding?.profile_role)}</p></div>
    <div class="detail-block"><strong>业务边界</strong><p>${escapeHtml((candidate.scope?.includes || []).join("；"))}</p></div>
    <div class="detail-block"><strong>排除项</strong><p>${escapeHtml((candidate.scope?.excludes || []).join("；"))}</p></div>
    <div class="detail-block"><strong>复杂度</strong><p>${escapeHtml(candidate.complexity?.level)} · ${candidate.complexity?.estimated_steps || 0} steps</p></div>
    <div class="detail-block"><strong>质量检查</strong><p>${escapeHtml(issues)}</p></div>`;
  $("#candidateTemplate").textContent = formatJson(candidate);
}

function renderTaskIoPools(tasks) {
  const taskMap = state.result?.task_map || {};
  const inputPool = taskMap.input_pool?.length
    ? taskMap.input_pool
    : tasks.flatMap((task) => (task.inputs || []).map((item, index) => ({
      ...item,
      pool_id: `${task.task_id}:input:${item.name || index}`,
      consumer_task_id: task.task_id,
      task_name: task.name,
      iteration: task.iteration || 1,
    })));
  const outputPool = taskMap.output_pool?.length
    ? taskMap.output_pool
    : tasks.flatMap((task) => (task.outputs || []).map((item, index) => ({
      ...item,
      pool_id: `${task.task_id}:output:${item.name || index}`,
      producer_task_id: task.task_id,
      task_name: task.name,
      iteration: task.iteration || 1,
      semantic_key: item.dedupe_key || item.name,
    })));
  const container = $("#taskIoPools");
  if (!inputPool.length && !outputPool.length) {
    container.className = "task-io-pools empty";
    container.innerHTML = "<p>任务生成后将在这里汇总输入池和输出池。</p>";
    return;
  }
  const renderPoolItem = (item, kind) => {
    const taskId = kind === "input" ? item.consumer_task_id : item.producer_task_id;
    const relation = kind === "input" ? "消费任务" : "生产任务";
    const detail = kind === "input"
      ? `${item.type || "object"} · ${item.input_origin || "unspecified"} · ${item.source || "unspecified"}${item.source_ref ? ` → ${item.source_ref}` : ""}`
      : `${item.type || "object"} · ${item.output_origin || "task_generated"} · ${item.semantic_key || item.dedupe_key || item.name}`;
    return `<article class="task-pool-item">
      <strong>${escapeHtml(item.display_name || item.name || item.pool_id)}</strong>
      <small>第 ${escapeHtml(item.iteration || 1)} 轮 · ${relation}：${escapeHtml(taskId)}</small>
      <small>${escapeHtml(detail)}</small>
      <p>${escapeHtml(item.description || "未提供语义描述")}</p>
    </article>`;
  };
  container.className = "task-io-pools";
  container.innerHTML = `
    <section class="task-pool-column">
      <header><h3>输入池</h3><span>${inputPool.length} 项</span></header>
      <div class="task-pool-list">${inputPool.map((item) => renderPoolItem(item, "input")).join("") || "<p>暂无输入</p>"}</div>
    </section>
    <section class="task-pool-column">
      <header><h3>输出池</h3><span>${outputPool.length} 项</span></header>
      <div class="task-pool-list">${outputPool.map((item) => renderPoolItem(item, "output")).join("") || "<p>暂无输出</p>"}</div>
    </section>`;
}

function renderTaskFlow() {
  const taskMap = state.result?.task_map || {};
  const tasks = taskMap.tasks || [];
  const graph = $("#taskFlowGraph");
  const stats = $("#taskFlowStats");
  if (!tasks.length) {
    graph.setAttribute("viewBox", "0 0 900 360");
    graph.innerHTML = '<text x="450" y="180" text-anchor="middle" class="graph-node-subtitle">等待任务池数据</text>';
    stats.innerHTML = "<span>0 个任务</span>";
    return;
  }
  const taskById = new Map(tasks.map((task) => [String(task.task_id), task]));
  const producerByRef = new Map();
  for (const output of taskMap.output_pool || []) {
    const producer = String(output.producer_task_id || "");
    if (!producer) continue;
    for (const value of [output.pool_id, output.semantic_key, output.dedupe_key, output.name]) {
      if (value) producerByRef.set(String(value), { producer, output });
    }
  }

  const taskLevels = new Map(tasks.map((task) => [String(task.task_id), 0]));
  for (let pass = 0; pass < tasks.length; pass += 1) {
    let changed = false;
    for (const task of tasks) {
      const taskId = String(task.task_id);
      const producers = (task.inputs || [])
        .filter((input) => input.source === "prior_output")
        .map((input) => producerByRef.get(String(input.source_ref || ""))?.producer || input.from_task || input.acquisition?.provider)
        .filter((producer) => producer && taskById.has(String(producer)));
      const nextLevel = producers.length
        ? Math.max(...producers.map((producer) => Number(taskLevels.get(String(producer)) || 0) + 1))
        : 0;
      if (nextLevel > Number(taskLevels.get(taskId) || 0)) {
        taskLevels.set(taskId, nextLevel);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const nodes = [];
  const edges = [];
  const dataNodes = new Map();
  const ensureDataNode = (key, metadata) => {
    const id = `data:${key}`;
    if (!dataNodes.has(key)) {
      const node = { id, kind: metadata.kind, layer: metadata.layer, label: metadata.label, data: metadata.data, producers: new Set(), consumers: new Set() };
      dataNodes.set(key, node);
      nodes.push(node);
    }
    const node = dataNodes.get(key);
    if (metadata.kind === "output") {
      node.kind = "output";
      node.layer = metadata.layer;
      node.data = metadata.data;
      node.label = metadata.label;
    }
    return node;
  };
  for (const task of tasks) {
    const taskId = String(task.task_id);
    nodes.push({ id: `task:${taskId}`, kind: "task", layer: Number(taskLevels.get(taskId) || 0) * 2 + 1, label: task.name, task });
  }
  for (const output of taskMap.output_pool || []) {
    const producer = String(output.producer_task_id || "");
    if (!taskById.has(producer)) continue;
    const semanticKey = graphKey(output.semantic_key || output.dedupe_key || output.name || output.pool_id);
    const taskLayer = Number(taskLevels.get(producer) || 0) * 2 + 1;
    const node = ensureDataNode(semanticKey, { kind: "output", layer: taskLayer + 1, label: output.display_name || output.name, data: output });
    node.producers.add(producer);
    edges.push({ from: `task:${producer}`, to: node.id, label: output.display_name || output.name });
  }
  for (const input of taskMap.input_pool || []) {
    const consumer = String(input.consumer_task_id || "");
    if (!taskById.has(consumer)) continue;
    const matched = input.source === "prior_output"
      ? producerByRef.get(String(input.source_ref || ""))
      : null;
    const semanticKey = matched
      ? graphKey(matched.output.semantic_key || matched.output.dedupe_key || matched.output.name || matched.output.pool_id)
      : graphKey(input.source_ref || input.semantic_key || input.name || input.display_name || input.pool_id);
    const node = ensureDataNode(semanticKey, {
      kind: matched ? "output" : "input",
      layer: matched ? Number(taskLevels.get(matched.producer) || 0) * 2 + 2 : 0,
      label: matched ? matched.output.display_name || matched.output.name : input.display_name || input.name,
      data: matched ? matched.output : input,
    });
    node.consumers.add(consumer);
    edges.push({ from: node.id, to: `task:${consumer}`, label: input.display_name || input.name });
  }

  const columns = new Map();
  for (const node of nodes) {
    if (!columns.has(node.layer)) columns.set(node.layer, []);
    columns.get(node.layer).push(node);
  }
  for (const items of columns.values()) items.sort((left, right) => String(left.label).localeCompare(String(right.label)));
  const layers = [...columns.keys()].sort((left, right) => left - right);
  const maxRows = Math.max(...[...columns.values()].map((items) => items.length));
  const width = Math.max(940, (Math.max(...layers) + 1) * 270 + 90);
  const height = Math.max(390, maxRows * 86 + 105);
  const positions = new Map();
  for (const layer of layers) {
    const items = columns.get(layer);
    const startY = 58 + ((maxRows - items.length) * 86) / 2;
    items.forEach((node, rowIndex) => positions.set(node.id, {
      x: 38 + layer * 270,
      y: startY + rowIndex * 86,
      width: 205,
      height: 58,
    }));
  }
  const edgeMarkup = edges.map((edge) => {
    const source = positions.get(edge.from);
    const target = positions.get(edge.to);
    if (!source || !target) return "";
    const x1 = source.x + source.width;
    const y1 = source.y + source.height / 2;
    const x2 = target.x;
    const y2 = target.y + target.height / 2;
    const bend = Math.max(42, Math.abs(x2 - x1) * 0.45);
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2 - 5;
    return `<path class="task-flow-edge" d="M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}" marker-end="url(#taskFlowArrow)"><title>${escapeHtml(edge.label)}</title></path><text x="${midX}" y="${midY}" text-anchor="middle" class="task-flow-edge-label">${escapeHtml(graphLabel(edge.label, 24))}</text>`;
  }).join("");
  const nodeMarkup = nodes.map((node) => {
    const position = positions.get(node.id);
    if (node.kind === "task") {
      return `<g class="task-flow-node task" transform="translate(${position.x} ${position.y})"><title>${escapeHtml(node.task.name)}\n${escapeHtml(node.task.task_id)}</title><rect width="${position.width}" height="${position.height}" rx="7"/><text x="11" y="23" class="graph-node-title">${escapeHtml(graphLabel(node.task.name, 22))}</text><text x="11" y="42" class="graph-node-subtitle">任务 · ${(node.task.inputs || []).length} 输入 / ${(node.task.outputs || []).length} 输出</text></g>`;
    }
    const sourceClass = node.kind === "input" ? escapeHtml(node.data?.source || "user_input") : "produced";
    const reused = node.consumers?.size > 1 ? " reused" : "";
    const subtitle = node.kind === "input"
      ? `共享输入 · ${node.consumers?.size || 0} 个任务`
      : `共享输出 · ${node.producers?.size || 0} 生产 / ${node.consumers?.size || 0} 消费`;
    return `<g class="task-flow-data-node ${node.kind} ${sourceClass}${reused}" transform="translate(${position.x} ${position.y})"><title>${escapeHtml(node.label)}\n语义键：${escapeHtml(node.id.replace(/^data:/, ""))}\n生产：${node.producers?.size || 0} · 消费：${node.consumers?.size || 0}</title><rect width="${position.width}" height="${position.height}" rx="7"/><text x="11" y="23" class="graph-node-title">${escapeHtml(graphLabel(node.label, 22))}</text><text x="11" y="42" class="graph-node-subtitle">${escapeHtml(subtitle)}</text></g>`;
  }).join("");
  const columnLabels = layers.map((layer) => `<text x="${38 + layer * 270}" y="30" class="graph-level-label">${layer % 2 === 0 ? "数据输入 / 输出" : "任务"} · L${layer}</text>`).join("");
  graph.setAttribute("viewBox", `0 0 ${width} ${height}`);
  graph.style.width = `${width}px`;
  graph.style.height = `${height}px`;
  graph.innerHTML = `<defs><marker id="taskFlowArrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="#64748b"/></marker></defs>${columnLabels}${edgeMarkup}${nodeMarkup}`;
  const rawDataCount = (taskMap.input_pool || []).length + (taskMap.output_pool || []).length;
  stats.innerHTML = `<span>${tasks.length} 个任务</span><span>${dataNodes.size} 个合并数据节点</span><span>${Math.max(0, rawDataCount - dataNodes.size)} 个重复节点已合并</span><span>${edges.length} 条数据流</span>`;
}

function renderTaskIterationView() {
  const checkpoints = state.result?.task_map?.iteration_checkpoints || [];
  const tabs = $("#taskIterationTabs");
  const view = $("#taskIterationView");
  if (!checkpoints.length) {
    tabs.innerHTML = "";
    view.className = "task-iteration-view empty";
    view.innerHTML = "<p>每轮任务将在合成后单独显示。</p>";
    return;
  }
  const available = checkpoints.map((item) => Number(item.iteration));
  if (!available.includes(Number(state.selectedTaskIteration))) {
    state.selectedTaskIteration = available[available.length - 1];
  }
  const directionLabels = { initialization: "初始化", discovery: "发现", decomposition: "拆解", extension: "延伸", composition: "延伸", deduplication: "去重" };
  tabs.innerHTML = checkpoints.map((item) => {
    const countLabel = item.direction === "decomposition"
      ? `替换 ${(item.removed_tasks || []).length} → ${(item.accepted_tasks || []).length}`
      : item.direction === "deduplication"
      ? `保留 ${(item.accepted_tasks || []).length}`
      : `新增 ${(item.accepted_tasks || []).length}`;
    return `<button class="task-iteration-tab${Number(item.iteration) === Number(state.selectedTaskIteration) ? " active" : ""}" data-task-iteration="${escapeHtml(item.iteration)}">第 ${escapeHtml(item.iteration)} 轮 · ${escapeHtml(directionLabels[item.direction] || "发现")} · ${countLabel}</button>`;
  }).join("");
  tabs.querySelectorAll("[data-task-iteration]").forEach((button) => button.addEventListener("click", () => {
    state.selectedTaskIteration = Number(button.dataset.taskIteration);
    renderTaskIterationView();
  }));
  const checkpoint = checkpoints.find((item) => Number(item.iteration) === Number(state.selectedTaskIteration)) || checkpoints.at(-1);
  const proposed = checkpoint.proposed_tasks || [];
  const accepted = checkpoint.accepted_tasks || [];
  const retained = checkpoint.retained_tasks || [];
  const removed = checkpoint.removed_tasks || [];
  const decisions = checkpoint.dedupe_decisions || [];
  const isDedupe = checkpoint.direction === "deduplication";
  const isDecomposition = checkpoint.direction === "decomposition";
  const taskList = (items) => items.map((task) => `<div class="iteration-task-item"><strong>${escapeHtml(task.name || task.task_id)}</strong><small>${escapeHtml(task.task_id)} · ${(task.inputs || []).length} 入 / ${(task.outputs || []).length} 出</small></div>`).join("") || "<p>暂无</p>";
  const relationList = accepted.map((task) => `<div class="iteration-decision-item"><strong>${escapeHtml(task.evolution_direction || checkpoint.direction || "discovery")}</strong> · ${escapeHtml(task.task_id)}<br>${escapeHtml((task.source_task_ids || []).length ? `来源：${task.source_task_ids.join(" · ")}` : "直接发现任务")}</div>`).join("") || "<p>本轮没有新增任务。</p>";
  const decisionList = decisions.map((item) => `<div class="iteration-decision-item"><strong>${escapeHtml(item.action || "unknown")}</strong> · ${escapeHtml(item.task_id || "未命名任务")}<br>${escapeHtml(item.reason || item.duplicate_of || "无补充说明")}</div>`).join("") || "<p>本轮没有移除语义重复任务。</p>";
  view.className = "task-iteration-view";
  view.innerHTML = `
    <div class="iteration-stats">
      <span class="iteration-stat">方向：${escapeHtml(directionLabels[checkpoint.direction] || "发现")}</span>
      <span class="iteration-stat">${isDedupe ? "去重前" : "候选"} ${proposed.length}</span><span class="iteration-stat">${isDedupe ? "去重后" : (isDecomposition ? "替换后子任务" : "本轮新增")} ${accepted.length}</span>${isDecomposition ? `<span class="iteration-stat">移除父任务 ${removed.length}</span>` : ""}<span class="iteration-stat">累计保留 ${retained.length}</span>
      <span class="iteration-stat">输入池 ${(checkpoint.input_pool || []).length}</span><span class="iteration-stat">输出池 ${(checkpoint.output_pool || []).length}</span>
      <span class="iteration-stat">本轮已完成</span>
    </div>
    <div class="iteration-columns">
      <section class="iteration-column"><h3>${isDedupe ? "去重前任务" : "本轮候选"}</h3><div class="iteration-task-list">${taskList(proposed)}</div></section>
      <section class="iteration-column"><h3>${isDedupe ? "去重后任务" : "本轮新增"}</h3><div class="iteration-task-list">${taskList(accepted)}</div></section>
      <section class="iteration-column"><h3>${isDedupe ? "去重决策" : (isDecomposition ? "被替换的父任务" : "迭代来源")}</h3><div class="iteration-decision-list">${isDedupe ? decisionList : (isDecomposition ? taskList(removed) : relationList)}</div></section>
    </div>
    <details class="iteration-pools"><summary>查看第 ${escapeHtml(checkpoint.iteration)} 轮完整输入池 / 输出池（JSON）</summary><div class="iteration-pool-grid"><pre>${escapeHtml(formatJson(checkpoint.input_pool || []))}</pre><pre>${escapeHtml(formatJson(checkpoint.output_pool || []))}</pre></div></details>`;
}

function renderTasks() {
  const tasks = state.result?.task_map?.tasks || [];
  const grid = $("#taskGrid");
  const iterations = state.result?.task_map?.iterations || [];
  const completedStages = new Set((state.result?.stages || []).map((item) => item.stage));
  const downstreamStarted = completedStages.has("candidate_synthesis") || Boolean(state.result?.direct_synthesis?.enabled);
  $$(".task-iteration-button").forEach((button) => {
    button.disabled = !tasks.length || downstreamStarted;
  });
  $("#taskCount").textContent = `${tasks.length} 个任务`;
  $("#taskIterationSummary").textContent = iterations.length
    ? `已完成 ${iterations.length} 轮；可以继续选择自然延伸、任务拆解或语义去重。`
    : "先初始化任务池，再自由选择下一轮迭代方式。";
  renderTaskIoPools(tasks);
  renderTaskIterationView();
  renderTaskFlow();
  if (!tasks.length) {
    grid.className = "task-grid empty";
    grid.innerHTML = "<p>没有任务数据。</p>";
    return;
  }
  grid.className = "task-grid";
  grid.innerHTML = tasks.map((task) => `<article class="task-card">
    <span class="task-id">第 ${escapeHtml(task.iteration || 1)} 轮 · ${escapeHtml(task.task_id)}</span>
    <h3>${escapeHtml(task.name)}</h3>
    <p>${escapeHtml(task.business_goal)}</p>
    <div class="task-contract"><strong>用户可能会这样说</strong>${(task.user_request_examples || []).map((item) => `<span>${escapeHtml(item)}</span>`).join("") || "<span>未提供自然问法</span>"}</div>
    <div class="task-contract"><strong>输入</strong>${(task.inputs || []).map((item) => `<span>${escapeHtml(item.name)} · ${escapeHtml(item.type || "未声明类型")} · ${escapeHtml(item.input_origin || "未声明来源类别")} · ${escapeHtml(item.source)}${item.required === false ? " · optional" : ""}<small>${escapeHtml(item.description || ((item.acquisition || {}).mode === "request_user" ? "调用时向用户获取" : ""))}</small></span>`).join("") || "<span>未声明</span>"}</div>
    <div class="task-contract"><strong>预测输出</strong>${(task.outputs || []).map((item) => `<span>${escapeHtml(item.display_name || item.name)} · ${escapeHtml(item.type || "未声明类型")} · ${escapeHtml(item.output_origin || "未声明来源类别")} · ${escapeHtml(item.dedupe_key || item.name)}<small>${escapeHtml(item.description || "")}</small></span>`).join("") || "<span>未声明</span>"}</div>
    <div class="dependencies">${task.dependencies?.length ? `依赖 ← ${task.dependencies.map(escapeHtml).join(" · ")}` : "起始任务"}</div>
  </article>`).join("");
}

function renderReferences() {
  const catalog = state.result?.tool_catalog || state.bootstrap?.tool_catalog || {};
  const tools = catalog.tools || [];
  $("#toolCount").textContent = `${tools.length} 个`;
  $("#toolCatalog").innerHTML = tools.map((tool) => `<div class="tool-item"><strong>${escapeHtml(tool.name)}</strong><small>${escapeHtml(tool.category)} · ${escapeHtml(tool.availability)}</small><small>${escapeHtml(tool.description)}</small></div>`).join("");
}

function renderResult() {
  renderPipeline();
  renderStages();
  renderQualityRubrics();
  if (!state.selectedSkillId) state.selectedSkillId = state.result?.final_candidates?.[0]?.skill_id || null;
  renderCandidates();
  renderInspector();
  renderTasks();
  renderReferences();
  renderArtifacts();
  renderGlobalIoGraph();
  $("#downloadButton").disabled = !state.result;
}

function setMode(mode) {
  state.mode = mode === "api" ? "api" : "mock";
  $$('.mode').forEach((item) => item.classList.toggle("active", item.dataset.mode === state.mode));
  $("#apiFields").classList.toggle("disabled", state.mode === "mock");
}

function loadResult(result, persistedRunId = null) {
  state.result = result;
  state.loadedRunId = persistedRunId;
  if (persistedRunId) state.currentPersist = true;
  const inputs = result.inputs || {};
  state.documents = {
    profile: typeof inputs.profile === "string" ? inputs.profile : formatJson(inputs.profile || {}),
    scenario: typeof inputs.scenario === "string" ? inputs.scenario : formatJson(inputs.scenario || {}),
  };
  selectScenarioForContent(state.documents.scenario);
  state.selectedSkillId = result.final_candidates?.[0]?.skill_id || null;
  state.selectedArtifactName = null;
  state.selectedArtifactFile = null;
  state.selectedTaskIteration = result.task_map?.iteration_checkpoints?.at(-1)?.iteration || null;
  setMode(result.model_mode);
  syncEditor();
  renderResult();
  renderPersistedTiming();
  renderRunList();
  const completed = new Set((result.stages || []).map((item) => item.stage));
  const tasksReady = completed.has("task_synthesis");
  const skillsDone = Boolean(result.direct_synthesis?.enabled || result.artifacts?.length);
  $("#skilltoolSynthesisButton").disabled = !tasksReady || skillsDone;
  $("#skilltoolSynthesisButton").textContent = skillsDone ? "SkillTool 已生成" : "根据任务集生成 SkillTool";
}

function renderRunList() {
  const container = $("#runList");
  if (!state.runs.length) {
    container.className = "run-list empty";
    container.innerHTML = "<p>还没有保存过合成结果。</p>";
    return;
  }
  container.className = "run-list";
  container.innerHTML = state.runs.map((run) => {
    const summary = run.summary || {};
    return `<button class="run-card ${run.run_id === state.loadedRunId ? "active" : ""}" data-run-id="${escapeHtml(run.run_id)}">
      <strong>${escapeHtml(run.run_id)}</strong>
      <small>${escapeHtml(run.model_name || run.model_mode || "unknown")} · ${run.run_status === "in_progress" ? `进行中：${escapeHtml(run.next_stage)}` : `${summary.skilltools || 0} SkillTools · ${qualitySummaryText(summary)}`}</small>
    </button>`;
  }).join("");
  $$(".run-card").forEach((button) => button.addEventListener("click", () => loadRun(button.dataset.runId)));
}

async function refreshRuns() {
  const response = await fetch("/api/runs");
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || "历史记录加载失败");
  state.runs = payload.runs || [];
  renderRunList();
}

async function loadRun(runId) {
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || "结果加载失败");
    loadResult(payload, runId);
    showToast(`已加载 ${runId}，输入和完整结果均可修改`);
  } catch (error) {
    showToast(error.message || String(error), true);
  }
}

async function requestSynthesisStage(stage, runId, previousResult, persist) {
  const response = await fetch("/api/synthesize-stage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stage,
      run_id: runId,
      result: persist ? undefined : previousResult,
      persist,
      mode: state.mode,
      model_config: modelConfigFromForm(),
      profile: documentPayload("profile"),
      scenario: documentPayload("scenario"),
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${payload.stage ? `${payload.stage}: ` : ""}${payload.message || payload.error}`);
  return payload;
}

function modelConfigurationReady() {
  if (state.mode !== "api") return true;
  if ($("#baseUrl").value.trim() && $("#modelName").value.trim()) return true;
  showToast("API 模式需要 Base URL 和 Model", true);
  return false;
}

async function synthesizeTasks() {
  if (!validateAllInputs()) {
    showToast("当前画像或场景内容为空", true);
    return;
  }
  if (!modelConfigurationReady()) return;
  const button = $("#taskSynthesisButton");
  button.disabled = true;
  button.textContent = "正在合成任务…";
  $("#skilltoolSynthesisButton").disabled = true;
  state.result = null;
  state.loadedRunId = null;
  state.currentPersist = $("#persistRun").checked;
  $("#taskCount").textContent = "0 个任务";
  $("#taskIterationSummary").textContent = "正在初始化任务池…";
  $("#taskGrid").className = "task-grid empty";
  $("#taskGrid").innerHTML = "<p>任务合成中…</p>";
  startMonitor(2, "新一轮任务合成已启动");
  try {
    monitorStageStarted("input_validation", 0);
    let payload = await requestSynthesisStage("input_validation", null, null, state.currentPersist);
    monitorStageCompleted("input_validation", 1, payload.stages?.find((item) => item.stage === "input_validation")?.duration_ms);
    monitorStageStarted("task_synthesis", 1);
    payload = await requestSynthesisStage("task_synthesis", payload.run_id, payload, state.currentPersist);
    monitorStageCompleted("task_synthesis", 2, payload.stages?.find((item) => item.stage === "task_synthesis")?.duration_ms);
    loadResult(payload, state.currentPersist ? payload.run_id : null);
    if (state.currentPersist) await refreshRuns();
    finishMonitor(true, `任务合成完成：保留 ${payload.summary.tasks || 0} 个任务`);
    showToast(`任务合成完成：最终保留 ${payload.summary.tasks || 0} 个任务`);
  } catch (error) {
    finishMonitor(false, error.message || String(error));
    $("#taskIterationSummary").textContent = `任务合成失败：${error.message || String(error)}`;
    showToast(error.message || String(error), true);
  } finally {
    button.disabled = false;
    button.textContent = "重新初始化任务池";
  }
}

async function iterateTaskPool(direction) {
  const tasks = state.result?.task_map?.tasks || [];
  if (!tasks.length) {
    showToast("当前任务池为空，请先初始化任务池", true);
    return;
  }
  if (!modelConfigurationReady()) return;
  const labels = { extension: "自然延伸", decomposition: "任务拆解", deduplication: "语义去重" };
  const buttons = $$(".task-iteration-button");
  const button = buttons.find((item) => item.dataset.direction === direction);
  const originalText = button.textContent;
  buttons.forEach((item) => { item.disabled = true; });
  button.textContent = "迭代中…";
  startMonitor(1, `${labels[direction]}已启动`);
  monitorEvent(labels[direction], "正在基于当前任务池生成下一轮");
  try {
    const response = await fetch("/api/iterate-task-pool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        run_id: state.result.run_id,
        result: state.currentPersist ? undefined : state.result,
        persist: state.currentPersist,
        direction,
        mode: state.mode,
        model_config: modelConfigFromForm(),
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || `${labels[direction]}失败`);
    monitorStageCompleted(labels[direction], 1, payload.iteration?.duration_ms);
    loadResult(payload.result, state.currentPersist ? payload.result.run_id : null);
    if (state.currentPersist) await refreshRuns();
    finishMonitor(true, `${labels[direction]}完成：当前 ${payload.result.summary.tasks || 0} 个任务`);
    showToast(`${labels[direction]}完成：当前 ${payload.result.summary.tasks || 0} 个任务`);
  } catch (error) {
    finishMonitor(false, error.message || String(error));
    showToast(error.message || String(error), true);
  } finally {
    button.textContent = originalText;
    renderTasks();
  }
}

async function synthesizeSkilltools() {
  if (!state.result || state.result.next_stage !== "candidate_synthesis") {
    showToast("请先完成任务合成，确认最终任务集后再生成 SkillTool", true);
    return;
  }
  if (!modelConfigurationReady()) return;
  const button = $("#skilltoolSynthesisButton");
  button.disabled = true;
  button.textContent = "正在组合任务与工具…";
  startMonitor(3, "直接 SkillTool 合成已启动");
  monitorStageStarted("task_tool_composition", 0);
  try {
    const response = await fetch("/api/direct-skilltools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        run_id: state.result.run_id,
        result: state.currentPersist ? undefined : state.result,
        persist: state.currentPersist,
        mode: state.mode,
        model_config: modelConfigFromForm(),
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || payload.error || "直接 SkillTool 合成失败");
    const directStages = payload.direct_synthesis?.stages || [];
    const directDuration = (stageId) => directStages.find((stage) => stage.id === stageId)?.duration_ms;
    monitorStageCompleted("task_tool_composition", 1, directDuration("task_tool_composition"));
    monitorStageCompleted("reference_render", 2, directDuration("reference_render"));
    monitorStageCompleted("artifact_validation", 3, directDuration("artifact_validation"));
    loadResult(payload, state.currentPersist ? payload.run_id : null);
    if (state.currentPersist) await refreshRuns();
    finishMonitor(true, `直接合成完成：${payload.summary.skilltools || 0} 个 SkillTool，${payload.direct_synthesis?.validation?.harness_tool_count || 0} 个 Harness Tool`);
    showToast(`SkillTool 合成完成：生成 ${payload.summary.skilltools || 0} 个`);
  } catch (error) {
    finishMonitor(false, error.message || String(error));
    showToast(error.message || String(error), true);
    button.disabled = false;
    button.textContent = "继续生成 SkillTool";
  }
}

function downloadResult() {
  if (!state.result) return;
  const blob = new Blob([formatJson(state.result)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${state.result.run_id}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function applyBootstrap(data) {
  state.bootstrap = data;
  const scenarios = data.scenarios?.length ? data.scenarios : [{
    scenario_id: "default_scenario",
    name: "默认场景",
    description: "服务端提供的默认业务场景。",
    content: data.scenario,
  }];
  state.bootstrap.scenarios = scenarios;
  state.scenarioDocuments = Object.fromEntries(
    scenarios.map((scenario) => [scenario.scenario_id, String(scenario.content || "")])
  );
  state.selectedScenarioId = data.default_scenario_id || scenarios[0].scenario_id;
  state.documents = {
    profile: typeof data.profile === "string" ? data.profile : formatJson(data.profile || {}),
    scenario: state.scenarioDocuments[state.selectedScenarioId],
  };
  $("#baseUrl").value = data.model_config.base_url || "";
  $("#modelName").value = data.model_config.model || "";
  $("#temperature").value = data.model_config.temperature ?? 0.2;
  $("#maxTokens").value = data.model_config.max_tokens ?? 6000;
  $("#timeoutMinutes").value = Number(data.model_config.timeout_seconds ?? 300) / 60;
  $("#apiKey").placeholder = data.model_config.api_key_configured ? "已由本地安全配置提供" : "仅用于本次请求";
  renderScenarioOptions();
  syncEditor();
  renderReferences();
  renderPipeline();
}

async function init() {
  try {
    const response = await fetch("/api/bootstrap");
    if (!response.ok) throw new Error("bootstrap failed");
    applyBootstrap(await response.json());
    await refreshRuns();
    $("#serviceStatus").className = "status online";
    $("#serviceStatus").textContent = "服务已连接";
  } catch (error) {
    $("#serviceStatus").className = "status error";
    $("#serviceStatus").textContent = "服务不可用";
    showToast(error.message, true);
  }
}

$$('.mode').forEach((button) => button.addEventListener("click", () => {
  setMode(button.dataset.mode);
}));

$$('.editor-tab').forEach((button) => button.addEventListener("click", () => {
  if (!validateEditor()) { showToast("请先填写当前内容", true); return; }
  state.activeEditor = button.dataset.editor;
  $$('.editor-tab').forEach((item) => item.classList.toggle("active", item === button));
  syncEditor();
}));

$("#jsonEditor").addEventListener("input", handleInputEdit);
$("#scenarioSelect").addEventListener("change", (event) => {
  state.selectedScenarioId = event.target.value;
  state.documents.scenario = state.scenarioDocuments[state.selectedScenarioId] || "";
  const selected = state.bootstrap?.scenarios?.find((item) => item.scenario_id === state.selectedScenarioId);
  $("#scenarioDescription").textContent = selected?.description || "该内容可继续修改。";
  syncEditor();
  handleInputEdit();
  showToast(`已切换到“${selected?.name || "自定义场景"}”`);
});
$("#taskSynthesisButton").addEventListener("click", synthesizeTasks);
$$(".task-iteration-button").forEach((button) => button.addEventListener("click", () => iterateTaskPool(button.dataset.direction)));
$("#skilltoolSynthesisButton").addEventListener("click", synthesizeSkilltools);
$("#downloadButton").addEventListener("click", downloadResult);
$("#ioZoomOut").addEventListener("click", () => changeIoGraphScale(-0.15));
$("#ioZoomReset").addEventListener("click", () => { state.ioGraphScale = 1; applyIoGraphScale(); });
$("#ioZoomIn").addEventListener("click", () => changeIoGraphScale(0.15));
$("#ioGraphDownload").addEventListener("click", downloadIoGraph);
$("#refreshRunsButton").addEventListener("click", () => refreshRuns().catch((error) => showToast(error.message, true)));
$("#resetButton").addEventListener("click", () => {
  if (state.bootstrap) applyBootstrap(state.bootstrap);
  showToast("已恢复固定画像和默认场景");
});

init();
