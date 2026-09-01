const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = { bootstrap: null, result: null, mode: "mock", runs: [], profiles: [], scenarios: [] };

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function toast(message, error = false) {
  const node = $("#toast"); node.textContent = message; node.className = error ? "show error" : "show";
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { node.className = ""; }, 3500);
}
function setMode(mode) {
  state.mode = mode === "api" ? "api" : "mock";
  $$('[data-mode]').forEach((button) => button.classList.toggle("active", button.dataset.mode === state.mode));
  $("#apiFields").classList.toggle("disabled", state.mode === "mock");
}
function numberFromInput(selector, label, { min, max, integer = false } = {}) {
  const value = Number($(selector).value);
  if (!Number.isFinite(value)) throw new Error(`${label} 必须是有效数字`);
  if (integer && !Number.isInteger(value)) throw new Error(`${label} 必须是整数`);
  if (min !== undefined && value < min) throw new Error(`${label} 不能小于 ${min}`);
  if (max !== undefined && value > max) throw new Error(`${label} 不能大于 ${max}`);
  return value;
}
function modelConfigFromForm() {
  return {
    base_url: $("#baseUrl").value.trim(),
    model: $("#modelName").value.trim(),
    api_key: $("#apiKey").value,
    temperature: numberFromInput("#temperature", "Temperature", { min: 0, max: 2 }),
    max_tokens: numberFromInput("#maxTokens", "Max tokens", { min: 1, integer: true }),
    timeout_seconds: numberFromInput("#timeoutSeconds", "Timeout", { min: 1, integer: true }),
  };
}
function stageOptions() {
  const html = state.bootstrap.stage_order.map((stage) => `<option value="${stage}">${escapeHtml(state.bootstrap.stage_labels[stage] || stage)}</option>`).join("");
  $("#fromStage").innerHTML = html; $("#toStage").innerHTML = html; $("#toStage").value = state.bootstrap.stage_order.at(-1);
}
function contextId(kind, index) {
  const items = kind === "profile" ? state.profiles : state.scenarios; let value = index + 1;
  while (items.some((item) => item[`${kind}_id`] === `${kind}_ui_${String(value).padStart(3, "0")}`)) value += 1;
  return `${kind}_ui_${String(value).padStart(3, "0")}`;
}
function renderContextEditors() {
  const renderItems = (kind, items, catalog) => items.map((item, index) => `<div class="context-editor" data-kind="${kind}" data-index="${index}"><div class="row"><select class="catalog"><option value="">自定义</option>${catalog.map((entry, catalogIndex) => `<option value="${catalogIndex}">${escapeHtml(entry.name)}</option>`).join("")}</select><button class="remove-context" type="button">删除</button></div><small>${escapeHtml(item[`${kind}_id`])}</small><input class="context-name" value="${escapeHtml(item.name || "")}" placeholder="名称"/><textarea class="context-content">${escapeHtml(item.content || "")}</textarea></div>`).join("");
  $("#profileEditors").innerHTML = renderItems("profile", state.profiles, state.bootstrap.profiles || []);
  $("#scenarioEditors").innerHTML = renderItems("scenario", state.scenarios, state.bootstrap.scenarios || []);
  $$(".context-editor").forEach((node) => {
    const kind = node.dataset.kind; const index = Number(node.dataset.index); const items = kind === "profile" ? state.profiles : state.scenarios; const catalog = state.bootstrap[`${kind}s`] || [];
    node.querySelector(".context-name").addEventListener("input", (event) => { items[index].name = event.target.value; });
    node.querySelector(".context-content").addEventListener("input", (event) => { items[index].content = event.target.value; });
    node.querySelector(".catalog").addEventListener("change", (event) => { const entry = catalog[Number(event.target.value)]; if (entry) { items[index].name = entry.name; items[index].content = entry.content; renderContextEditors(); } });
    node.querySelector(".remove-context").addEventListener("click", () => { if (items.length <= 1) return toast(`${kind} 至少保留一个`, true); items.splice(index, 1); renderContextEditors(); });
  });
}
function addContext(kind) {
  const items = kind === "profile" ? state.profiles : state.scenarios;
  items.push({ [`${kind}_id`]: contextId(kind, items.length), name: `${kind} ${items.length + 1}`, content: "" });
  renderContextEditors();
}
function bindingsFromForm() {
  const text = $("#bindingsJson").value.trim(); if (!text) return null;
  const value = JSON.parse(text); if (!Array.isArray(value)) throw new Error("bindings 必须是 JSON 数组"); return value;
}
function renderStages() {
  const completed = new Set(state.result?.completed_stages || []);
  $("#stages").innerHTML = state.bootstrap.stage_order.map((stage) => `<div class="stage ${completed.has(stage) ? "done" : state.result?.next_stage === stage ? "next" : ""}"><b>${escapeHtml(state.bootstrap.stage_labels[stage])}</b><small>${completed.has(stage) ? "完成" : state.result?.next_stage === stage ? "下一阶段" : "等待"}</small></div>`).join("");
}
function cards(target, items, renderer, empty) {
  const node = $(target); node.className = items.length ? node.className.replace(" empty", "") : `${node.className.replace(" empty", "")} empty`;
  node.innerHTML = items.length ? items.map(renderer).join("") : empty;
}
function render() {
  renderStages(); const result = state.result || {};
  $("#runMeta").textContent = result.run_id ? `${result.run_id} · ${result.run_status} · next: ${result.next_stage || "none"}` : "尚未运行";
  const p0 = result.p0_tasks || []; $("#p0Count").textContent = `${p0.length} 个`;
  const coverage = result.p0_coverage || {}; $("#p0Coverage").textContent = coverage.profiles ? `画像 ${coverage.profiles.covered.length} · 场景 ${coverage.scenarios.covered.length} · bindings ${coverage.bindings.covered.length} · 跨场景任务 ${coverage.cross_scenario_tasks || 0}` : "";
  cards("#p0", p0, (task) => `<article><small>${escapeHtml(task.task_id)} · ${escapeHtml(task.context_contract?.mode || "")}</small><h3>${escapeHtml(task.name)}</h3><p>${escapeHtml(task.business_goal)}</p><div class="chips">${(task.context_contract?.profile_ids || []).map((id) => `<span>P: ${escapeHtml(id)}</span>`).join("")}${(task.context_contract?.scenario_ids || []).map((id) => `<span>S: ${escapeHtml(id)}</span>`).join("")}</div></article>`, "等待 Stage 1.6");
  const relations = result.latent_relations || []; $("#relationCount").textContent = `${relations.length} 个`;
  cards("#relations", relations, (item) => `<article><small>${escapeHtml(item.task_id)} · ${item.m}→${item.n}</small><h3>${escapeHtml(item.task_name)}</h3><code>${escapeHtml(item.label)}</code><p>${escapeHtml(item.relation_summary)}</p></article>`, "等待 Stage 2.1");
  const objects = result.object_set?.canonical_objects || []; $("#objectCount").textContent = `${objects.length} 个`;
  cards("#objects", objects, (item) => `<article><small>${escapeHtml(item.object_id)} · ${escapeHtml(item.type)}</small><h3>${escapeHtml(item.display_name)}</h3><p>${escapeHtml(item.description)}</p><div class="chips">${Object.entries(item.role_statistics || {}).map(([key, value]) => `<span>${key}:${value}</span>`).join("")}</div></article>`, "等待 Stage 2.2");
  const sampled = result.sampled_relations || []; $("#sampleCount").textContent = `${sampled.length} 个`;
  cards("#sampled", sampled, (item) => `<article><small>${escapeHtml(item.relation_id)} · k=${item.k}</small><code>${escapeHtml(item.relation_signature)}</code></article>`, "等待 Stage 3.1");
  const p1 = result.p1_tasks || result.p1_task_candidates || []; $("#p1Count").textContent = `${p1.length} 个`;
  cards("#p1", p1, (task) => `<article><small>${escapeHtml(task.task_id)} · ${escapeHtml(task.relation_contract?.label)}</small><h3>${escapeHtml(task.name)}</h3><p>${escapeHtml(task.business_goal)}</p><div class="chips">${(task.inputs || []).map((item) => `<span>I: ${escapeHtml(item.display_name || item.name)}</span>`).join("")}<span>O: ${escapeHtml(task.outputs?.[0]?.display_name || "")}</span></div></article>`, "等待 Stage 3.3");
  const artifacts = result.artifacts || []; $("#skillCount").textContent = `${artifacts.length} 个`;
  cards("#skills", artifacts, (item, index) => `<button class="artifact-card" data-artifact="${index}"><b>${escapeHtml(item.skill_name)}</b><small>${Object.keys(item.files || {}).map(escapeHtml).join(" · ")}</small></button>`, "等待 Stage 4.2");
  $$('.artifact-card').forEach((button) => button.addEventListener("click", () => { const item = artifacts[Number(button.dataset.artifact)]; $("#artifact").textContent = JSON.stringify(item.files, null, 2); }));
  renderRuns();
}
function renderRuns() {
  cards("#runs", state.runs, (run) => `<button class="run-card" data-run="${escapeHtml(run.run_id)}"><b>${escapeHtml(run.run_id)}</b><small>${escapeHtml(run.run_status)} · P1 ${run.summary?.p1_tasks || 0} · Skills ${run.summary?.skills || 0}</small></button>`, "暂无运行");
  $$('.run-card').forEach((button) => button.addEventListener("click", () => loadRun(button.dataset.run)));
}
async function refreshRuns() { const response = await fetch("/api/runs"); const data = await response.json(); state.runs = data.runs || []; renderRuns(); }
async function loadRun(runId) { const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`); const data = await response.json(); if (!response.ok) throw new Error(data.message); state.result = data; state.profiles = structuredClone(data.inputs?.profiles || state.profiles); state.scenarios = structuredClone(data.inputs?.scenarios || state.scenarios); $("#bindingsJson").value = data.inputs?.binding_mode === "explicit" ? JSON.stringify(data.inputs.bindings || [], null, 2) : ""; renderContextEditors(); setMode(data.model_mode); render(); }
async function run() {
  const button = $("#runButton"); button.disabled = true; button.textContent = "运行中…";
  try {
    const response = await fetch("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      run_id: state.result?.run_status !== "completed" ? state.result?.run_id : null,
      mode: state.mode, profiles: state.profiles, scenarios: state.scenarios, bindings: bindingsFromForm(),
      from_stage: $("#fromStage").value, to_stage: $("#toStage").value,
      model_config: modelConfigFromForm(),
      sampling: { seed: Number($("#seed").value), target_count: Number($("#targetCount").value), candidate_multiplier: 3, k_min: Number($("#kMin").value), k_max: Number($("#kMax").value), mode: $("#samplingMode").value },
      p0: { target_count: Number($("#p0TargetCount").value), cross_scenario_ratio: Number($("#crossScenarioRatio").value), max_bindings: Number($("#maxBindings").value), bridge_tasks_per_group: Number($("#bridgeTasks").value) },
    }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.message || data.error);
    state.result = data; await refreshRuns(); render(); toast(`完成到 ${data.completed_stages.at(-1)}`);
  } catch (error) { toast(error.message || String(error), true); await refreshRuns(); }
  finally { button.disabled = false; button.textContent = "运行所选区间"; }
}
async function init() {
  const response = await fetch("/api/bootstrap"); state.bootstrap = await response.json();
  state.profiles = [{ profile_id: "profile_ui_001", name: state.bootstrap.profiles?.[0]?.name || "profile 1", content: state.bootstrap.profile }];
  state.scenarios = [{ scenario_id: "scenario_ui_001", name: state.bootstrap.scenarios?.[0]?.name || "scenario 1", content: state.bootstrap.scenario }];
  renderContextEditors();
  const defaults = state.bootstrap.sampling_defaults; $("#seed").value = defaults.seed; $("#targetCount").value = defaults.target_count; $("#kMin").value = defaults.k_min; $("#kMax").value = defaults.k_max;
  const p0Defaults = state.bootstrap.p0_defaults; $("#p0TargetCount").value = p0Defaults.target_count; $("#crossScenarioRatio").value = p0Defaults.cross_scenario_ratio; $("#maxBindings").value = p0Defaults.max_bindings; $("#bridgeTasks").value = p0Defaults.bridge_tasks_per_group;
  const model = state.bootstrap.model_config;
  $("#baseUrl").value = model.base_url || ""; $("#modelName").value = model.model || "";
  $("#temperature").value = model.temperature ?? 0.2;
  $("#maxTokens").value = model.max_tokens ?? 6000;
  $("#timeoutSeconds").value = model.timeout_seconds ?? 120;
  $("#apiKey").placeholder = model.api_key_configured ? "已由本地安全配置提供" : "仅用于本次请求";
  stageOptions(); renderStages(); await refreshRuns(); $("#status").textContent = "服务已连接";
}
$$('[data-mode]').forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
$("#runButton").addEventListener("click", run);
$("#addProfile").addEventListener("click", () => addContext("profile"));
$("#addScenario").addEventListener("click", () => addContext("scenario"));
init().catch((error) => { $("#status").textContent = "连接失败"; toast(error.message || String(error), true); });
