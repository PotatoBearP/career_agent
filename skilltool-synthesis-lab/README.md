# SkillTool Synthesis Lab

一个与 Career-Agent 主程序完全解耦的批量 SkillTool 合成实验室。

## 能力

```text
复杂用户画像 + 当前状态 + 独立业务场景
  → 需求分析
  → 任务 / 场景合成
  → SkillTool candidates
  → 语义降重、合并与拆分评审
  → 确定性质量门
  → SKILL.md + action-tool.json + eval cases
```

质量门检查：

- Skill 是否与其他候选语义冗余；
- 业务目标是否过于简单或包含多个应拆分的决策；
- 必需 input 是否来自可获得来源；
- output 是否有明确 schema 和消费者；
- 是否依赖主程序路由、数据库、UI 状态或内部服务；
- 任务场景是否得到完整覆盖。
- 是否把专业、项目或技能错误推断为场景目标领域；
- 辅助工具是否来自非 Skill 工具目录、确有必要并说明使用模式与降级路径。

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

API Key 只随本次浏览器请求发送到本地服务，不会写入 `run.json`。管线会对模型发起四次 JSON 合成请求：需求、任务、候选、降重合并。

支持的 endpoint 输入：

```text
https://provider.example.com
https://provider.example.com/v1
https://provider.example.com/v1/chat/completions
```

它们都会规范化到 Chat Completions endpoint。

## 输入记录

- `data/profiles/*.json`：相对稳定的个人画像和证据；
- `data/states/*.json`：当前阶段、假设、进度和决策期限；
- `data/scenarios/*.json`：业务目标、范围和必需输出；
- `data/model_config.example.json`：不含密钥的模型配置样例。
- `data/templates/skilltool_template.json`：合成时强制遵守、WebUI 可查看的 SkillTool 模板；
- `data/tools/project_tools.json`：从项目 `getAllBaseTools` 建立的独立非 Skill 工具快照。

Web UI 可直接编辑三类 JSON。每次 run 会保存完整输入、各阶段中间结果、质量报告和最终候选，确保可复现和审计。

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
      tests/eval_cases.json
```

生成的 `action-tool.json` 参考当前抽象的 Action Skill Tool 模板，并增加 `child_tools` 精确子 Agent 工具声明。`tool_selection` 同时记录每个工具是 `required`、`optional` 还是 `conditional`，以及选择理由、触发条件和降级路径。运行时应由 Harness 自动补入 `ReturnSkillResult`，它不在可选工具目录内。

工具目录默认一个都不选。只有完成具体业务目标需要时，模型才可以从目录中选择普通工具；Skill、Skill 发现工具、生成的 SkillActionTool 和 ReturnSkillResult 均被排除，避免嵌套 Skill。

## 扩展新场景

1. 增加 profile/state/scenario JSON，或通过 Web UI 粘贴。
2. 在 `pipeline/prompts.py` 调整合成约束或输出契约。
3. 在 `pipeline/quality.py` 增加业务专属质量门。
4. 使用模型 API 运行，复核 `dedupe_decisions` 与质量报告。
5. 将通过质量门的 generated-skills 接入目标 SkillTool runtime。

本目录不 import Career-Agent 的任何模块，也不读写它的数据库或运行状态。
