# SkillTool Synthesis Lab

当前 Web UI 每一道工序的实际执行函数、模型 Prompt、`ref/` 参考来源和落盘位置，见 [`PROCESS_README.md`](PROCESS_README.md)。

## 能力

```text
自然语言用户画像 + 自然语言业务场景
  → 输入检验
  → 初始化任务池 + 自由选择自然延伸 / 任务拆解 / 语义去重
  → 最终自然任务池
  → 任务 + 最小必要普通工具 / 可选 Harness Tool
  → 按 ref/skills 与 ref/tools 生成
  → 产物契约校验
  → SKILL.md + action-tool.json + 可选 harness-tools.json + eval cases
```

当前直接产物校验：

- 每个可合成任务必须且只能生成一个 SkillTool；
- 候选必须具有名称、Action Tool 名称和可执行 workflow；
- `child_tools` 必须与普通工具选择完全一致；
- 可选 Harness Tool 必须具有合法阶段、触发条件、2–5 个步骤以及输入输出契约；
- 最终公开输入输出会按确认后的任务池确定性归一。

当前 Web UI 的直接流程跳过旧版候选降重与质量门；旧版脚本仍保留用于兼容和研究。两条路径的具体区别见流程文档。

## 快速开始

无需安装第三方依赖，需要 Python 3.10+。

```powershell
cd skilltool-synthesis-lab
py -3 server.py
```

打开 <http://127.0.0.1:8790>。Windows 也可以运行 `start.cmd` 或 `start.ps1`。

首次建议使用“离线样例”。画像是一名计算机专业研究生，但场景是领域开放的“行业探索与机会发现”；系统不会因为用户学计算机就把场景收窄为 AI 行业，不消耗模型额度。

命令行运行样例：

```powershell
py -3 server.py --run-sample
```

运行测试：

```powershell
py -3 -m unittest discover -s tests -v
```

## 使用特定模型 API

Web UI 中选择“模型 API”，填写：

- OpenAI-compatible Base URL；
- 模型名称；
- API Key；
- temperature 和 max tokens。

API Key 只随本次浏览器请求发送到本地服务，不会写入 `run.json`。任务发现、解构和延申各自生成并保存 checkpoint，不在单轮生成中隐式去重；语义去重作为独立任务迭代执行并保存自己的决策与前后任务池。后续轮次失败不会丢失已完成任务；候选阶段按 SkillTool 任务逐个请求并在每个候选完成后 checkpoint；候选降重阶段只评审紧凑摘要。

也可以创建 Git 忽略的 `data/model_config.local.json` 保存本机默认模型配置。服务启动时会自动加载该文件，Web 只会收到“密钥已配置”的标志，不会取得或显示密钥；浏览器中临时填写的非空配置仍可覆盖本机默认值。

支持的 endpoint 输入：

```text
https://provider.example.com
https://provider.example.com/v1
https://provider.example.com/v1/chat/completions
```

它们都会规范化到 Chat Completions endpoint。

命令行可直接运行或恢复 API 合成，并可临时覆盖本地模型名：

```powershell
py -3 server.py --run-api-sample
py -3 server.py --run-api-sample --api-model DeepSeek-V3.2-Instruct
py -3 server.py --resume-api-run <run-id> --api-model DeepSeek-V3.2-Instruct
py -3 server.py --recheck-run <run-id>
```

只执行并保存一轮真实任务合成（API Key 通过隐藏输入读取）：

```powershell
py -3 scripts/run_one_task_round.py --base-url https://provider.example.com --model Model-Name
```

从已保存的第一轮任务池继续执行后续解构和延申：

```powershell
py -3 scripts/run_task_evolution.py --source-run-id <run-id> --base-url https://provider.example.com --model Model-Name
```

如需用脚本复现一组固定顺序的任务迭代，可运行：

```powershell
py -3 scripts/run_full_task_iteration.py --base-url https://provider.example.com --model Model-Name
```

从已确认的最终任务池继续生成旧版候选评审结果：

```powershell
py -3 scripts/run_skilltools_from_task_pool.py --run-id <run-id> --base-url https://provider.example.com --model Model-Name
```

如果已经确认最终任务池，只需把任务与必要工具直接融合并按 `ref/skills` 的样式生成，使用简化批处理入口：

```powershell
py -3 scripts/run_direct_skilltool_batch.py --run-id <run-id>
```

该入口默认在本地确定性生成，不发送画像或任务数据到外部服务；它只执行任务—工具组合、参考样式渲染和产物校验，跳过去重与质量门。只有在明确允许向配置的模型服务发送任务数据时，才添加 `--use-model`。

Web UI 不再绑定固定的四轮顺序。初始化任务池后，可按任意顺序重复选择“自然延伸”“任务拆解”或“语义去重”；每次操作都会保存独立 checkpoint。开始生成 SkillTool 后，任务池锁定。

初始化轮采用覆盖型约束：必须生成 8–10 个现实、完整且可由自然用户单独提出的任务，并至少声明 8 个不同的场景结果。每个初始化任务都必须进入 coverage；数量不足、覆盖缺失或通过内部步骤机械凑数都会触发模型纠正。

解构轮执行替换：只有在一个复杂父任务能够拆成至少两个自然用户会直接提出的小任务时才成立；父任务从有效任务池及其输入输出池中移除，子任务记录父任务 `source_task_ids`，被替换父任务保存在 checkpoint 的 `removed_tasks` 中供审计。已有下游任务正在消费其输出的父任务不会被直接拆除，以免形成断链。延申轮沿一个或多个已有任务输出形成用户在多轮对话中的自然后续请求。

## 输入记录

- `data/profiles/*.txt`：用自然语言描述的个人画像和证据；
- `data/scenarios/*.txt`：用自然语言描述的业务目标、范围和必需输出；
- `data/model_config.example.json`：不含密钥的模型配置样例。
- `data/templates/skilltool_template.json`：合成时强制遵守、WebUI 可查看的 SkillTool 模板；
- `data/tools/project_tools.json`：从项目 `getAllBaseTools` 建立的独立工具快照；只把已有实现的非 MCP、非递归 Skill 工具暴露给合成模型，并记录平台、环境变量或 feature flag 等可用条件。

Web UI 可直接编辑画像和场景文本，不要求 JSON 格式。画像和场景用于决定应当合成哪些能力，但不能成为一级任务的运行时产物依赖；一级任务必须只通过调用时向用户收集普通输入即可直接执行。每个任务必须先预测输出及稳定的输出语义键；初始化、任务拆解和自然延伸不会隐式删除语义相近任务，需要时通过独立“语义去重”审计并更新任务池。

Web UI 的“历史合成”区域会列出已保存的运行。加载历史记录后，可以：

- 查看并继续编辑当时的画像和场景，再次合成一条新记录；
- 恢复最终任务集、SkillTool 候选、质量报告和生成产物；
- 浏览每个通过直接产物校验的 SkillTool 及其 `SKILL.md`、工具契约、候选 JSON 和测试用例；
- 在任务合成区按轮切换，分别查看该轮候选、新增任务、去重决策以及当时的完整输入池和输出池。
- 在任务 Flow 中按真实数据依赖查看“输入 → 任务 → 输出 → 下游任务”。布局由输入输出的生产者—消费者关系决定，不按任务生成轮次排列；解构来源属于迭代审计信息，不会被画成运行时数据依赖。

新生成记录的任务迭代完整轨迹和候选合成紧凑轨迹保存在 `run.json` 的 `synthesis_trace` 字段中。请求轨迹不会保存 API Key。旧记录仍可检查原先保存的阶段输出，但历史文件没有记录的 Prompt 和模型原始响应无法追溯补全。

每个阶段同时会作为独立文件落盘，便于不经过 Web 页面直接检查：

```text
runs/<run-id>/
  stage-manifest.json
  intermediate-results/
    01-input-validation.json
    02-task-synthesis.json
    ...
  stages/02-task-synthesis/iterations/<NN>/
    checkpoint.json
    proposed-tasks.json
    accepted-tasks.json
    retained-tasks.json
    input-pool.json
    output-pool.json
    dedupe-decisions.json
    iteration-control.json
    user-prompt.txt
    model-request.json
    raw-response.txt
  stages/
    02-task-synthesis/
      stage.json
      input.json
      parsed-output.json
      iterations/01/
        system-prompt.txt
        user-prompt.txt
        model-request.json
        model-exchange.json
        parsed-output.json
        dedupe-decisions.json
```

新运行的 `<run-id>` 会包含实际模型名，例如 `run-20260815-220000-qwen3-7-plus-a1b2c3d4`；`run.json` 中也会单独记录 `model_name`。

Web UI 先执行一次“初始化任务池”，随后允许用户自由、重复地选择自然延伸、任务拆解或语义去重。确认任务池后再点击“根据任务集生成 SkillTool”；第二步严格消费当前任务池，不会重新发现任务。旧版五阶段执行器、分阶段控制、Prompt 轨迹面板和完整结果编辑器已从主界面移除，但历史 `run.json` 仍可读取。

组合采用 parallel-first 约束：场景默认合成为一组平行、独立可调用的能力，而不是固定流水线。最终任务契约会确定性覆盖候选的公开输入输出，并验证必需上游输出和声明消费者确实存在。只有比较、排序或跨结果综合等少数 aggregate 能力可以要求其他 SkillTool 输出。

## 生成产物

保存模式下：

```text
runs/<run-id>/
  run.json
  generated-skills/
    <skill-name>/
      SKILL.md
      action-tool.json
      skilltool.json
      harness-tools.json       # 仅需要简单 Harness 工序时生成
      tests/eval_cases.json
```

生成的 `action-tool.json` 参考当前抽象的 Action Skill Tool 模板，并增加 `child_tools` 精确子 Agent 工具声明。`tool_selection` 同时记录每个工具是 `required`、`optional` 还是 `conditional`，以及选择理由、触发条件和降级路径。运行时应由 Harness 自动补入 `ReturnSkillResult`，它不在可选工具目录内。

候选合成会读取 `ref/skills/*/SKILL.md` 与对应的 `action-tool.json`，提取各章节的代表性运行时片段作为结构示范；同时从 `ref/tools` 提取适合作为简单 Harness Tool 的确定性工序示例。模型必须据此为每个候选生成专属的角色、硬边界、工作流、判定规则、结果分支、产物校验和返回前检查；reference 的业务内容不会直接复制到新 Skill。

工具目录默认一个都不选。只有完成具体业务目标需要时，模型才可以从目录中选择普通工具；MCP 工具、Skill、Skill 发现工具、生成的 SkillActionTool、ReturnSkillResult、测试工具和空实现占位均被排除。排除审计记录保存在目录文件中，但不会进入模型可见的可选工具 payload，避免模型把排除项误认为可调用工具。

## 扩展新场景

1. 增加 profile/scenario 自然语言文本，或通过 Web UI 粘贴。
2. 在 `pipeline/prompts.py` 调整合成约束或输出契约。
3. 如有需要，在 `data/tools/project_tools.json` 补充可选择的普通工具。
4. 使用模型 API 运行，复核每轮 checkpoint、最终任务池和直接产物校验结果。
5. 将通过直接校验的 generated-skills 接入目标 SkillTool runtime。

本目录不 import Career-Agent 的任何模块，也不读写它的数据库或运行状态。
