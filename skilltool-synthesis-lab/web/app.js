const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  bootstrap: null,
  documents: { profile: {}, state: {}, scenario: {} },
  activeEditor: "profile",
  mode: "mock",
  result: null,
  selectedSkillId: null,
};

const labels = {
  profile: "复杂用户画像 JSON",
  state: "个人状态 JSON",
  scenario: "业务场景 JSON",
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
  $("#jsonEditor").value = formatJson(state.documents[state.activeEditor]);
  validateEditor();
}

function validateEditor() {
  const validity = $("#jsonValidity");
  try {
    const parsed = JSON.parse($("#jsonEditor").value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
    state.documents[state.activeEditor] = parsed;
    validity.textContent = "JSON 有效";
    validity.className = "validity valid";
    return true;
  } catch {
    validity.textContent = "JSON 无效";
    validity.className = "validity invalid";
    return false;
  }
}

function modelConfigFromForm() {
  return {
    base_url: $("#baseUrl").value.trim(),
    model: $("#modelName").value.trim(),
    api_key: $("#apiKey").value,
    temperature: Number($("#temperature").value || 0.2),
    max_tokens: Number($("#maxTokens").value || 6000),
    timeout_seconds: 120,
  };
}

function renderPipeline(runState = "idle") {
  if (!state.bootstrap) return;
  const completed = new Set();
  const stageMap = {
    demand_analysis: "needs",
    task_synthesis: "tasks",
    candidate_synthesis: "candidates",
    dedupe_merge: "dedupe",
    quality_gate: "skilltools",
  };
  if (state.result) {
    completed.add("profile");
    for (const stage of state.result.stages || []) completed.add(stageMap[stage.stage]);
  }
  $("#pipelineFlow").innerHTML = state.bootstrap.pipeline.map((node, index) => {
    const status = completed.has(node.id) ? "complete" : runState === "running" && index === 1 ? "running" : "";
    const details = node.id === "profile"
      ? state.documents.profile.identity?.persona || state.documents.profile.persona || "profile.json"
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
  if (id === "needs") return `${summary.needs || 0} needs`;
  if (id === "tasks") return `${summary.tasks || 0} tasks`;
  if (id === "candidates") return `${state.result?.candidate_generation?.raw_count || 0} raw`;
  if (id === "dedupe") return `${state.result?.candidate_generation?.final_count || 0} retained`;
  if (id === "skilltools") return `${summary.eligible_artifacts || 0} artifacts`;
  return "completed";
}

function renderMetrics() {
  const values = state.result
    ? [state.result.summary.needs, state.result.summary.tasks, state.result.summary.skilltools, state.result.summary.quality_score]
    : ["—", "—", "—", "—"];
  $$("#summaryMetrics strong").forEach((element, index) => { element.textContent = values[index]; });
}

function renderStages() {
  const strip = $("#stageStrip");
  if (!state.result) { strip.innerHTML = ""; return; }
  strip.innerHTML = (state.result.stages || []).map((stage) =>
    `<span class="stage-chip ${escapeHtml(stage.status)}">${escapeHtml(stage.stage)} · ${escapeHtml(stage.status)} · ${stage.duration_ms}ms</span>`
  ).join("");
  $("#runMeta").textContent = `${state.result.run_id} · ${state.result.model_mode}`;
}

function qualityReport(skillId) {
  return (state.result?.quality?.candidate_reports || []).find((item) => item.skill_id === skillId) || { passed: false, score: 0, issues: [] };
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
    const active = candidate.skill_id === state.selectedSkillId ? "active" : "";
    const tools = candidate.tool_selection?.length
      ? candidate.tool_selection.map((item) => `${item.tool_name} · ${item.usage_mode}`)
      : ["不使用辅助工具"];
    return `<article class="candidate-card ${active}" data-skill-id="${escapeHtml(candidate.skill_id)}">
      <header><div><h3>${escapeHtml(candidate.title)}</h3><span class="subtle">${escapeHtml(candidate.tool_name)}</span></div><span class="mini-score ${report.passed ? "" : "warn"}">${report.score}</span></header>
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
  if (!candidate) return;
  const report = qualityReport(candidate.skill_id);
  $("#inspectorTitle").textContent = candidate.title;
  const badge = $("#qualityBadge");
  badge.textContent = `${report.score} / 100`;
  badge.className = `score-badge ${report.passed ? "pass" : "warn"}`;
  const inputs = Object.entries(candidate.input_schema || {});
  const outputs = Object.entries(candidate.output_schema || {});
  const tools = candidate.child_tools?.length ? candidate.child_tools.join(" · ") : "无辅助工具";
  $("#ioGraph").className = "io-graph";
  $("#ioGraph").innerHTML = `<div class="io-layout">
    <div class="io-column"><h4>INPUTS</h4>${inputs.map(([name, field]) => `<div class="io-node ${field.available ? "" : "unavailable"}"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(field.source)} · ${escapeHtml(field.type)}${field.required ? " · required" : ""}</small><small>${escapeHtml(field.description)}</small></div>`).join("")}</div>
    <div class="io-arrow">→</div>
    <div class="io-core"><strong>${escapeHtml(candidate.tool_name)}</strong><small>外部模型子上下文</small><div class="consumer-list">${escapeHtml(tools)}</div></div>
    <div class="io-arrow">→</div>
    <div class="io-column"><h4>OUTPUTS</h4>${outputs.map(([name, field]) => `<div class="io-node"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(field.type)}</small><small>${escapeHtml(field.description)}</small></div>`).join("")}<div class="consumer-list">消费方：${(candidate.output_consumers || []).map(escapeHtml).join(" · ")}</div></div>
  </div>`;
  const issues = report.issues?.length ? report.issues.map((item) => item.message).join("；") : "全部质量门通过";
  const selections = candidate.tool_selection || [];
  $("#toolPolicy").className = "tool-policy";
  $("#toolPolicy").innerHTML = `<h3>辅助工具策略</h3>${selections.length ? selections.map((item) => `<div class="tool-row">
    <strong>${escapeHtml(item.tool_name)}</strong><span class="usage">${escapeHtml(item.usage_mode)}</span>
    <div><div>${escapeHtml(item.reason)}</div>${item.condition ? `<small>条件：${escapeHtml(item.condition)}</small>` : ""}${item.fallback ? `<small>降级：${escapeHtml(item.fallback)}</small>` : ""}</div>
  </div>`).join("") : "<p>无需辅助工具：仅分析已提供输入。</p>"}`;
  $("#skillDetails").innerHTML = `
    <div class="detail-block"><strong>场景绑定</strong><p>${escapeHtml(candidate.scenario_binding?.domain_mode)} · domain from ${escapeHtml(candidate.scenario_binding?.domain_source)} · profile ${escapeHtml(candidate.scenario_binding?.profile_role)}</p></div>
    <div class="detail-block"><strong>业务边界</strong><p>${escapeHtml((candidate.scope?.includes || []).join("；"))}</p></div>
    <div class="detail-block"><strong>排除项</strong><p>${escapeHtml((candidate.scope?.excludes || []).join("；"))}</p></div>
    <div class="detail-block"><strong>复杂度</strong><p>${escapeHtml(candidate.complexity?.level)} · ${candidate.complexity?.estimated_steps || 0} steps</p></div>
    <div class="detail-block"><strong>质量检查</strong><p>${escapeHtml(issues)}</p></div>`;
  $("#candidateTemplate").textContent = formatJson(candidate);
}

function renderTasks() {
  const tasks = state.result?.task_map?.tasks || [];
  const grid = $("#taskGrid");
  if (!tasks.length) return;
  grid.className = "task-grid";
  grid.innerHTML = tasks.map((task) => `<article class="task-card">
    <span class="task-id">${escapeHtml(task.task_id)}</span>
    <h3>${escapeHtml(task.name)}</h3>
    <p>${escapeHtml(task.business_goal)}</p>
    <div class="dependencies">${task.dependencies?.length ? `依赖 ← ${task.dependencies.map(escapeHtml).join(" · ")}` : "起始任务"}</div>
  </article>`).join("");
  const coverage = state.result.quality.coverage;
  $("#coverageBadge").textContent = `${coverage.covered_tasks} / ${coverage.total_tasks} covered`;
}

function renderResult() {
  renderPipeline();
  renderMetrics();
  renderStages();
  if (!state.selectedSkillId) state.selectedSkillId = state.result?.final_candidates?.[0]?.skill_id || null;
  renderCandidates();
  renderInspector();
  renderTasks();
  $("#downloadButton").disabled = !state.result;
}

async function runSynthesis() {
  if (!validateEditor()) {
    showToast("当前编辑器中的 JSON 无效", true);
    return;
  }
  if (state.mode === "api" && (!$("#baseUrl").value.trim() || !$("#modelName").value.trim())) {
    showToast("API 模式需要 Base URL 和 Model", true);
    return;
  }
  const button = $("#runButton");
  button.disabled = true;
  button.textContent = "合成中…";
  state.result = null;
  state.selectedSkillId = null;
  renderPipeline("running");
  $("#runMeta").textContent = state.mode === "mock" ? "运行离线完整样例" : "正在调用外部模型 API（4 stages）";
  try {
    const response = await fetch("/api/synthesize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: state.mode,
        model_config: modelConfigFromForm(),
        profile: state.documents.profile,
        state: state.documents.state,
        scenario: state.documents.scenario,
        persist: $("#persistRun").checked,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`${payload.stage ? `${payload.stage}: ` : ""}${payload.message || payload.error}`);
    state.result = payload;
    renderResult();
    showToast(`完成：生成 ${payload.summary.skilltools} 个 SkillTool，质量分 ${payload.summary.quality_score}`);
  } catch (error) {
    $("#runMeta").textContent = "运行失败";
    renderPipeline();
    showToast(error.message || String(error), true);
  } finally {
    button.disabled = false;
    button.textContent = "开始合成";
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
  state.documents = { profile: data.profile, state: data.state, scenario: data.scenario };
  $("#baseUrl").value = data.model_config.base_url || "";
  $("#modelName").value = data.model_config.model || "";
  $("#temperature").value = data.model_config.temperature ?? 0.2;
  $("#maxTokens").value = data.model_config.max_tokens ?? 6000;
  $("#templateView").textContent = formatJson(data.skilltool_template);
  const tools = data.tool_catalog?.tools || [];
  $("#toolCount").textContent = `${tools.length} 个`;
  $("#toolCatalog").innerHTML = tools.map((tool) => `<div class="tool-item"><strong>${escapeHtml(tool.name)}</strong><small>${escapeHtml(tool.category)} · ${escapeHtml(tool.availability)}</small><small>${escapeHtml(tool.description)}</small></div>`).join("");
  syncEditor();
  renderPipeline();
  renderMetrics();
}

async function init() {
  try {
    const response = await fetch("/api/bootstrap");
    if (!response.ok) throw new Error("bootstrap failed");
    applyBootstrap(await response.json());
    $("#serviceStatus").className = "status online";
    $("#serviceStatus").textContent = "服务已连接";
  } catch (error) {
    $("#serviceStatus").className = "status error";
    $("#serviceStatus").textContent = "服务不可用";
    showToast(error.message, true);
  }
}

$$('.mode').forEach((button) => button.addEventListener("click", () => {
  state.mode = button.dataset.mode;
  $$('.mode').forEach((item) => item.classList.toggle("active", item === button));
  $("#apiFields").classList.toggle("disabled", state.mode === "mock");
}));

$$('.editor-tab').forEach((button) => button.addEventListener("click", () => {
  if (!validateEditor()) { showToast("请先修复当前 JSON", true); return; }
  state.activeEditor = button.dataset.editor;
  $$('.editor-tab').forEach((item) => item.classList.toggle("active", item === button));
  syncEditor();
}));

$("#jsonEditor").addEventListener("input", validateEditor);
$("#runButton").addEventListener("click", runSynthesis);
$("#downloadButton").addEventListener("click", downloadResult);
$("#resetButton").addEventListener("click", () => {
  if (state.bootstrap) applyBootstrap(state.bootstrap);
  showToast("已恢复计算机研究生与开放行业探索样例");
});

init();
