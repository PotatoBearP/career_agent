# SkillTool 合成详细流程

本文档描述当前 Web UI 使用的真实执行路径，并指出每一步的前端入口、HTTP 接口、后端实现、模型 Prompt、参考文件和落盘结果。

主流程以代码为准；`scripts/` 中仍保留部分固定顺序或旧版质量评审脚本，它们不是当前前端默认工序。

## 1. 当前完整流程

```text
加载画像、场景、工具目录
  ↓
确定性输入检查
  ↓
模型初始化任务池（一次）
  ↓
用户自由选择并可重复执行：
  ├─ 模型自然延伸
  ├─ 模型任务拆解
  └─ 确定性语义去重
  ↓
用户确认当前任务池
  ↓
按任务逐个调用模型，组合 SkillTool + 普通工具 + 可选 Harness Tool
  ↓
确定性任务契约归一
  ↓
确定性直接产物校验
  ↓
按 ref 样式渲染 SKILL.md、action-tool.json、可选 harness-tools.json 和测试用例
  ↓
保存 run.json、任务迭代 Prompt/响应、阶段记录和生成产物
```

开始 SkillTool 合成后，任务池锁定，不能再执行延伸、拆解或去重。若要改变任务池，需要重新初始化一轮任务。

## 2. 工序总表

| 工序 | 前端入口 | HTTP 接口 | 实际执行 | 是否调用模型 | Prompt / 规则位置 |
|---|---|---|---|---|---|
| 加载配置 | 页面初始化 | `GET /api/bootstrap` | `server.py::bootstrap_payload` | 否 | 画像、场景、模板和工具目录文件 |
| 输入检查 | “初始化任务池”的第一步 | `POST /api/synthesize-stage`，`stage=input_validation` | `pipeline/input_validation.py::validate_inputs` | 否 | 确定性输入契约规则，无 Prompt |
| 初始化任务池 | “初始化任务池”的第二步 | `POST /api/synthesize-stage`，`stage=task_synthesis` | `SynthesisPipeline.advance` | 是 | `SYSTEM_PROMPT` + `task_synthesis_prompt(..., iteration_direction="initialization")` |
| 自然延伸 | “自然延伸” | `POST /api/iterate-task-pool` | `server.py::iterate_result_task_pool` → `SynthesisPipeline.advance` | 是 | `task_synthesis_prompt(..., iteration_direction="extension")` |
| 任务拆解 | “任务拆解” | `POST /api/iterate-task-pool` | `server.py::iterate_result_task_pool` → `SynthesisPipeline.advance` | 是 | `task_synthesis_prompt(..., iteration_direction="decomposition")` |
| 语义去重 | “语义去重” | `POST /api/iterate-task-pool` | `dedupe_result_task_pool` → `pipeline/synthesis.py::dedupe_task_pool` | 否 | 三路语义相似度和池清理规则，无 Prompt |
| SkillTool 合成 | “根据任务集生成 SkillTool” | `POST /api/direct-skilltools` | `SynthesisPipeline.advance(..., "candidate_synthesis")` | 是 | `SYSTEM_PROMPT` + `candidate_synthesis_prompt` + `ref/` 摘要 |
| 任务契约归一 | SkillTool 合成内部 | 同上 | `_normalize_candidate_to_task_contract` | 否 | 最终任务池契约为准，无 Prompt |
| 直接校验 | SkillTool 合成内部 | 同上 | `pipeline/direct_synthesis.py::validate_direct_candidates` | 否 | 覆盖、工具和 Harness Tool 结构规则 |
| 产物渲染 | SkillTool 合成内部 | 同上 | `pipeline/artifacts.py::build_artifact_preview` | 否 | `render_skill_md`、`render_action_tool` |
| 保存结果 | 每个成功工序之后 | 上述 POST 接口 | `persist_run_snapshot` | 否 | 原子替换与阶段文件规则 |
| 前端展示 | 每次接口返回之后 | 无额外接口 | `web/app.js::loadResult` 及各 render 函数 | 否 | 前端显示逻辑 |

## 3. 启动与加载输入

### 3.1 前端执行

页面启动逻辑在 [`web/app.js`](web/app.js)：

- `init()` 请求 `/api/bootstrap` 和历史 runs；
- `renderScenarioOptions()` 生成场景下拉框；
- `documentPayload()` 取得当前固定画像和所选场景；
- `modelConfigFromForm()` 读取 API 地址、模型名、API Key、temperature 和 max tokens。

场景选择只改变场景文本，画像保持不动。

### 3.2 后端执行

[`server.py::bootstrap_payload`](server.py) 读取：

- `data/profiles/computer_ai_graduate.txt`：当前自然语言画像；
- `data/scenarios/*.txt`：可选自然语言场景；
- `data/templates/skilltool_template.json`：候选 SkillTool JSON 结构；
- `data/tools/project_tools.json`：模型可以选择的普通工具目录；
- 本地模型配置：只向前端暴露不含密钥的字段。

这一过程不调用模型，也没有 Prompt。

## 4. 初始化任务池

前端 [`synthesizeTasks()`](web/app.js) 连续发出两个请求。

### 4.1 输入检查

请求：

```json
{
  "stage": "input_validation",
  "mode": "mock 或 api",
  "persist": true,
  "profile": "当前画像文本",
  "scenario": "当前场景文本",
  "model_config": {}
}
```

后端入口位于 [`server.py::LabHandler.do_POST`](server.py)，创建 `SynthesisPipeline` 和初始 `run_id`，随后执行：

```python
pipeline.advance(result, "input_validation")
```

真实逻辑位于 [`pipeline/input_validation.py::validate_inputs`](pipeline/input_validation.py)：

1. 从自然语言场景中识别形如 ``已有产物 `user_profile` `` 的上游产物声明；
2. 把画像和场景本身登记为输入资产；
3. 检查资产 ID、类型、来源、可用状态、生产者、描述、派生关系和获取路径；
4. 返回 `input_inventory`、`checks`、`issues` 和汇总数字。

此步骤完全确定性执行，不调用模型，也没有参考 Prompt。其执行轨迹标记为 `deterministic_input_validation`。

### 4.2 模型初始化任务池

第二个请求仍发往 `/api/synthesize-stage`，但 `stage` 为 `task_synthesis`。前端会携带第一步返回的 `run_id` 和未保存模式所需的完整 `result`。

后端把本轮固定为：

```python
task_iteration_limit=1
task_iteration_directions=("initialization",)
```

执行核心位于 [`pipeline/synthesis.py::SynthesisPipeline.advance`](pipeline/synthesis.py) 的 `task_synthesis` 分支。

模型实际收到两段 Prompt：

1. 系统 Prompt：[`pipeline/prompts.py::SYSTEM_PROMPT`](pipeline/prompts.py)
2. 用户 Prompt：[`pipeline/prompts.py::task_synthesis_prompt`](pipeline/prompts.py)

初始化时，用户 Prompt 的 `ITERATION DIRECTION` 为 `initialization`，并嵌入：

- 当前画像；
- 当前场景；
- 输入检查得到的已有场景产物；
- 可选择的普通工具目录；
- 初始化专属覆盖规则；
- 任务、输入、输出、coverage 和 iteration control 的 JSON 返回结构；
- 自然用户表达、画像与场景解耦、来源类型、输出消费者等约束。

初始化专属规则要求生成 8–10 个自然用户可以单独提出的任务，并覆盖至少 8 个不同场景结果。任务不能依赖其他任务输出。

### 4.3 模型返回后的确定性检查

模型返回 JSON 后，仍需经过 [`pipeline/synthesis.py`](pipeline/synthesis.py) 中的代码检查：

- `_validate_initialization_coverage`：数量和 coverage；
- `_validate_task_io_contract`：输入来源、类型、输出类型和消费者；
- `_validate_task_evolution_contract`：初始化方向及空 `source_task_ids`；
- `_profile_specific_literals`：防止把样例画像中的具体事实固化进通用任务；
- `build_task_io_pools`：重建统一输入池和输出池。

若契约检查失败，会把具体错误和上一份 JSON 附加到原 Prompt 后，最多请求模型纠正两次，即单轮最多三次模型尝试。纠正 Prompt 直接在 [`SynthesisPipeline.advance`](pipeline/synthesis.py) 的 `CORRECTION REQUIRED` 字符串中组装。

成功后生成第一个 `iteration_checkpoint`，并重新执行一次输入检查，把普通工具任务产生的可获取资产加入输入清单。

## 5. 三种自由任务迭代

前端入口是 [`web/app.js::iterateTaskPool`](web/app.js)，统一调用：

```http
POST /api/iterate-task-pool
```

请求中的 `direction` 为 `extension`、`decomposition` 或 `deduplication`。后端统一入口是 [`server.py::iterate_result_task_pool`](server.py)。

迭代编号取当前 checkpoint 最大编号加一，因此三种操作可以任意排序、重复执行，不依赖固定轮次。

### 5.1 自然延伸

自然延伸重新进入 `SynthesisPipeline.advance(..., "task_synthesis")`，但只运行当前新增的一轮：

```python
task_iteration_start=next_iteration
task_iteration_limit=next_iteration
task_iteration_directions=("extension",)
```

Prompt 仍由 [`task_synthesis_prompt`](pipeline/prompts.py) 生成，但会额外注入：

- 之前保留的任务；
- 当前输入池；
- 当前输出池；
- `EXTENSION ONLY` 方向规则。

规则要求新任务必须自然承接一个或多个已有任务输出，`source_task_ids` 必须对应真实生产任务，且至少有一个 `prior_output` 输入。面向用户的名称、目标和示例不能出现“可验证、证据链、置信度、评估矩阵、建模、映射”等分析术语。

确定性检查位于 `_validate_task_evolution_contract`，会核对来源任务和实际消费的输出生产者是否一致。

### 5.2 任务拆解

任务拆解同样使用 [`task_synthesis_prompt`](pipeline/prompts.py)，方向为 `decomposition`。

`DECOMPOSITION REPLACEMENT ONLY` 规则要求：

- 只拆真正过宽的父任务；
- 每个父任务至少产生两个自然、可独立使用的子任务；
- 每个子任务只声明同一个父任务 ID；
- 已被其他保留任务消费输出的父任务不能拆除；
- 不得把“提取、映射、评分、格式化”等内部步骤暴露为用户任务。

确定性检查由 `_validate_decomposition_replacements` 完成。拆解成功后，父任务从当前任务池、输入池、输出池和 coverage 中移除，原父任务保存在 checkpoint 的 `removed_tasks` 中。

### 5.3 语义去重

语义去重不调用模型，没有 Prompt。

执行链：

```text
server.py::iterate_result_task_pool
  → server.py::dedupe_result_task_pool
  → pipeline/synthesis.py::dedupe_task_pool
```

[`dedupe_task_pool`](pipeline/synthesis.py) 同时比较任务的：

- 输入语义；
- 输出语义；
- 名称与业务目标描述。

只有三方面共同达到重复条件才会删除任务，避免因为输出名字相似而误删目标或输入不同的任务。删除后会同步清理输入池、输出池、coverage、消费者引用和依赖，并记录 `dedupe_decisions`。

## 6. 根据最终任务池生成 SkillTool

前端入口是 [`web/app.js::synthesizeSkilltools`](web/app.js)，调用：

```http
POST /api/direct-skilltools
```

后端首先确认：

- 任务池非空；
- 当前 `next_stage` 为 `candidate_synthesis`；
- 运行模式没有从 Mock 切换到 API，或反向切换；
- SkillTool 合成尚未开始。

### 6.1 每个任务单独调用模型

后端执行：

```python
pipeline.advance(result, "candidate_synthesis")
```

实现位于 [`pipeline/synthesis.py`](pipeline/synthesis.py) 的 `candidate_synthesis` 分支。当前 `batch_size = 1`，所以每个 `synthesis_decision == "skilltool"` 的任务都会单独发起一次模型请求，已完成的任务可以从 checkpoint 继续，不必全部重跑。

模型实际使用：

1. [`pipeline/prompts.py::SYSTEM_PROMPT`](pipeline/prompts.py)
2. [`pipeline/prompts.py::candidate_synthesis_prompt`](pipeline/prompts.py)

候选 Prompt 会嵌入：

- 当前唯一目标任务和它的预测输出；
- 压缩后的画像与当前场景；
- `data/templates/skilltool_template.json`；
- `data/tools/project_tools.json` 中可选择的非 Skill 普通工具；
- `ref/skills` 中的参考 Skill 摘要和 `action-tool.json`；
- `ref/tools` 中适合作为简单 Harness Tool 的 TypeScript 摘要；
- `reference_design_principles()` 返回的参考设计原则；
- 完整 SkillTool、工作流、工具选择、Harness Tool 和测试用例返回结构。

### 6.2 `ref/` 是怎样进入 Prompt 的

参考加载逻辑位于 [`pipeline/reference_skills.py`](pipeline/reference_skills.py)：

- `load_reference_skill_pack()` 遍历 `ref/skills/*/SKILL.md` 和同目录 `action-tool.json`；
- `_runtime_excerpt()` 从每个章节提取代表性运行时说明，控制 Prompt 体积；
- `load_reference_harness_tool_pack()` 遍历 `ref/tools/*/*.ts`；
- `artifactAdapter.ts` 和仅包装 Skill action 的递归工具会被排除；
- 最多选择六个适合作为 before/after 简单工序的确定性工具示例。

当前 Skill 参考包括：

- `ref/skills/baseline-assessment/`
- `ref/skills/career-competency-model/`
- `ref/skills/learning-plan/`
- `ref/skills/learning-progress-assessment/`
- `ref/skills/learning-stage-design/`

参考文件只提供边界、步骤、契约和验证写法，不会把参考 Skill 的业务内容复制到新场景。

### 6.3 普通工具与 Harness Tool 的区别

普通工具来自 `data/tools/project_tools.json`：

- 由 Skill 在执行过程中调用；
- 写入 `tool_selection` 和 `child_tools`；
- 默认不选，只有任务确实需要时才选择；
- 新鲜外部数据通常使用 `WebSearch`，必要时条件调用 `WebFetch`。

Harness Tool 来自模型根据 `ref/tools` 结构生成的简单 before/after 工序：

- 不属于 `child_tools`；
- 只做确定性、短小的准备或收尾；
- 必须声明 `phase`、`purpose`、`trigger`、2–5 个步骤及输入输出契约；
- 仅在任务确实需要简单过程时生成。

### 6.4 任务契约归一

模型候选返回后，代码调用 [`_normalize_candidate_to_task_contract`](pipeline/synthesis.py)：

- 强制候选只绑定当前任务；
- 用最终任务池覆盖候选的公开输入和输出 schema；
- 把任务输出池引用转换为真实 prior Skill 输入；
- 决定 `standalone` 或 `aggregate`；
- 修正输出消费者和组合关系。

因此最终任务池是 SkillTool 公共契约的唯一权威来源，模型不能自行改变任务输入输出。

## 7. 直接校验与产物生成

模型候选全部完成后，HTTP 主流程调用 [`pipeline/direct_synthesis.py::finalize_direct_result`](pipeline/direct_synthesis.py)。当前前端路径明确跳过旧版 `dedupe_merge` 和 `quality_gate`。

### 7.1 直接校验

[`validate_direct_candidates`](pipeline/direct_synthesis.py) 确定性检查：

- 每个可合成任务必须且只能被一个候选覆盖；
- 每个候选必须有 `skill_name` 和 `tool_name`；
- 必须存在可执行 workflow；
- `child_tools` 必须与 `tool_selection` 完全一致；
- Harness Tool 名称不能冲突；
- Harness Tool 必须有合法阶段、触发条件、2–5 个步骤以及输入输出契约。

此处不调用模型，不做自动修复。校验失败时整个直接合成请求返回错误。

### 7.2 产物渲染

[`pipeline/artifacts.py::build_artifact_preview`](pipeline/artifacts.py) 为每个候选生成：

```text
SKILL.md
action-tool.json
skilltool.json
tests/eval_cases.json
harness-tools.json        # 仅候选声明 Harness Tool 时存在
```

其中：

- `render_skill_md()` 把候选工作流、边界、输入、工具策略、结果分支和返回检查渲染成运行时 Skill；
- `render_action_tool()` 生成 Action Tool 搜索和输入契约；
- Harness Tool 声明单独写入 `harness-tools.json`，不会混入 Skill 的子工具列表。

产物渲染不再调用模型；模型生成的是结构化候选 JSON，文件由确定性模板函数完成。

## 8. 模型 API 的真实执行位置

API 模式由 [`pipeline/model_api.py::OpenAICompatibleModel`](pipeline/model_api.py) 实现。

`complete_json()` 会：

1. 把系统 Prompt 和用户 Prompt 组装为 OpenAI-compatible `messages`；
2. 请求配置地址的 `/v1/chat/completions`；
3. 解析 `choices[0].message.content`；
4. 去除可选 Markdown JSON fence 并解析一个 JSON 值；
5. 若 JSON 语法无效，使用同一模型执行一次仅修复 JSON 语法的请求；
6. 保存 endpoint、请求、原始响应、正文、finish reason 和可选修复记录到 trace。

JSON 修复 Prompt 直接定义在 [`pipeline/model_api.py`](pipeline/model_api.py) 的 `repair_payload` 中，只允许修复语法，不允许改字段和值。

API Key 只用于当前 HTTP 请求的 Authorization header，不会由 `public_model_config()` 返回前端，也不会写入 `run.json`。

Mock 模式使用 [`pipeline/mock_model.py::MockSynthesisModel`](pipeline/mock_model.py)，不发送外部请求，但走相同的管线检查、checkpoint、归一、校验和渲染逻辑。

## 9. 保存目录和每一步的实际 Prompt

保存运行后，根目录为：

```text
runs/<run-id>/
```

完整状态在：

```text
runs/<run-id>/run.json
```

任务每轮 checkpoint 在：

```text
runs/<run-id>/stages/02-task-synthesis/iterations/<NN>/
```

其中常用文件：

```text
checkpoint.json          # 本轮完整状态
proposed-tasks.json      # 模型提出的任务
accepted-tasks.json      # 通过契约检查的任务
removed-tasks.json       # 拆解或去重移除的任务
retained-tasks.json      # 本轮完成后的任务池
input-pool.json
output-pool.json
dedupe-decisions.json
iteration-control.json
system-prompt.txt        # 本轮实际系统 Prompt；确定性去重可能没有
user-prompt.txt          # 本轮实际用户 Prompt；确定性去重可能没有
model-request.json       # API 模式下的真实请求
raw-response.txt         # API 模式下的原始响应
parsed-output.json       # 解析后的模型输出或确定性报告
```

阶段级文件位于：

```text
runs/<run-id>/stages/<NN>-<stage>/
runs/<run-id>/intermediate-results/
runs/<run-id>/stage-manifest.json
```

逐任务 SkillTool 合成的紧凑 trace 保存在 `run.json` 的 `synthesis_trace` 中。为了避免运行文件过大，批次 trace 会压缩；需要核对任务迭代的完整实际 Prompt 时，优先查看上述 iteration 目录。

最终生成文件位于：

```text
runs/<run-id>/generated-skills/<skill-name>/
```

保存逻辑位于 [`pipeline/artifacts.py::persist_run_snapshot`](pipeline/artifacts.py)，先写 `run.json.tmp`，再原子替换 `run.json`，之后刷新阶段文件和 generated skills。

## 10. 前端如何展示运行过程

主要逻辑位于 [`web/app.js`](web/app.js)：

- `synthesizeTasks()`：顺序执行输入检查和初始化；
- `iterateTaskPool(direction)`：执行三种自由迭代；
- `synthesizeSkilltools()`：执行直接 SkillTool 合成；
- `startMonitor()`、`monitorStageCompleted()`、`finishMonitor()`：显示实时耗时；
- `renderTasks()`：显示任务和三个迭代按钮的可用状态；
- `renderTaskIterationView()`：按 checkpoint 显示每轮结果；
- `renderTaskFlow()`：显示任务输入输出依赖；
- `renderGlobalIoGraph()`：按语义合并相同 SkillTool 输入输出节点；
- `renderArtifacts()`：浏览最终产物文件。

按钮与布局位于 [`web/index.html`](web/index.html)，样式位于 [`web/styles.css`](web/styles.css)。

## 11. Prompt 与参考文件索引

### 当前主流程 Prompt

| 用途 | 定义位置 | 调用位置 |
|---|---|---|
| 全局 SkillTool 架构规则 | `pipeline/prompts.py::SYSTEM_PROMPT` | `SynthesisPipeline._stage` |
| 初始化任务池 | `pipeline/prompts.py::task_synthesis_prompt` 的 `initialization` 规则 | `SynthesisPipeline.advance/task_synthesis` |
| 自然延伸 | 同一函数的 `extension` 规则 | `iterate_result_task_pool` → `advance/task_synthesis` |
| 任务拆解 | 同一函数的 `decomposition` 规则 | `iterate_result_task_pool` → `advance/task_synthesis` |
| 任务契约纠正 | `pipeline/synthesis.py` 中 `CORRECTION REQUIRED` 字符串 | 单轮任务校验失败后 |
| SkillTool + 工具 + Harness Tool 合成 | `pipeline/prompts.py::candidate_synthesis_prompt` | `advance/candidate_synthesis` |
| JSON 语法修复 | `pipeline/model_api.py` 中 `repair_payload` | 模型响应无法解析时 |

### 当前主流程没有 Prompt 的步骤

- 输入检查；
- 语义去重；
- 输入输出池构建；
- 任务契约归一；
- 直接候选校验；
- SKILL.md 和 JSON 产物渲染；
- 保存、计时和前端绘图。

### 旧版兼容 Prompt

[`pipeline/prompts.py::dedupe_merge_prompt`](pipeline/prompts.py) 仍供旧版完整管线和脚本使用，但当前 `/api/direct-skilltools` 前端流程明确跳过候选降重与旧质量门。不要把它当成当前 Web UI 的必经步骤。

## 12. 修改流程时应该改哪里

- 修改任务自然表达、初始化覆盖、延伸或拆解规则：`pipeline/prompts.py::task_synthesis_prompt`。
- 修改输入输出、来源或拆解的硬校验：`pipeline/synthesis.py` 对应 `_validate_*` 函数。
- 修改语义去重阈值或策略：`pipeline/synthesis.py::_task_semantic_similarity`、`_is_semantic_task_duplicate` 和 `dedupe_task_pool`。
- 修改 SkillTool 结构、工具选择或 Harness Tool 要求：`pipeline/prompts.py::candidate_synthesis_prompt`。
- 修改参考 Skill/Tool 的读取范围：`pipeline/reference_skills.py`。
- 增删可选普通工具：`data/tools/project_tools.json`。
- 修改最终 SKILL.md 或 Action Tool 文件格式：`pipeline/artifacts.py`。
- 修改直接流程的最低产物校验：`pipeline/direct_synthesis.py`。
- 修改前端工序与按钮：`web/index.html`、`web/app.js`、`web/styles.css`。
- 修改 HTTP 请求和运行状态控制：`server.py`。

修改后至少执行：

```powershell
node --check web/app.js
py -3 -m py_compile server.py pipeline/synthesis.py pipeline/mock_model.py
py -3 -m unittest discover -s tests -v
```
