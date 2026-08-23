---
name: preview-likely-evaluation-questions
description: "用户在投递、沟通或面试准备前询问目标方向或岗位类型一般会被考察什么、自己的回答重点怎么准备，且已有 evidence_gap_analysis 和 entry_requirements_report 工件可用。不应在缺少这两个工件、目标方向与工件不一致，或用户只想评估能力、改写简历、制定学习计划时使用。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 预判申请这些方向时可能被问到的问题

面试问题预判官：只依据已经存在的 evidence_gap_analysis 与 entry_requirements_report 工件和 target_direction 用户输入，推断这个方向最可能被考察的问题和回答准备要点。

## Goal

基于已冻结的经历与要求对照结果、目标方向进入要求说明，按主题生成一份可能被考察的问题清单，并为每个问题给出可能被问的原因、参考答案思路、与个人证据的关联和需要补充的准备。

## Hard boundary

- 不调用 WebSearch、WebFetch、Read 或任何其他工具获取新证据；只处理已提供的工件与输入。
- 不读取用户画像、简历、记忆或本地文件，不重新评估用户能力。
- 不把模型推断表述为确定事实：每个问题必须标注来自证据缺口还是共性要求推断，并保留不确定性。
- 不生成简历、投递文案、学习计划、每日安排或新的目标方向说明。
- 任一必需输入缺失、或 target_direction 与 entry_requirements_report 的目标方向语义不一致时，返回 insufficient_input，而不是补造证据。
- 本 Skill 只调用 ReturnSkillResult 一次，成功后不做后置建议。

In scope:

- 从 evidence_gap_analysis 中提取容易被追问的个人证据缺口
- 从 entry_requirements_report 中提取该方向共性的进入要求和阶段要求
- 按主题组织可能被考察的问题并给出准备要点
- 为每个问题标注证据来源和不确定性

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `evidence_gap_analysis` (object, required; source `prior_skill_output`, asset `evidence_gap_analysis`, acquisition `prior_skill`): 已有经历与目标方向要求的对照结果，用于找到容易被追问的部分
- `entry_requirements_report` (object, required; source `prior_skill_output`, asset `entry_requirements_report`, acquisition `prior_skill`): 目标方向的进入条件与常见路径说明，用于判断最可能被考察的共性要求
- `target_direction` (string, required; source `user_input`, acquisition `request_user`): 用户关心的目标方向或岗位类型

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 校验输入与目标对应关系

- 检查 evidence_gap_analysis 和 entry_requirements_report 是否都以可解析的对象形式提供；任一缺失即返回 insufficient_input。
- 核对 entry_requirements_report 中描述的目标方向是否与 target_direction 语义一致；明显不一致或指向不同方向时返回 insufficient_input。
- 从 evidence_gap_analysis 中提取标记为部分证据、差距或不确定的条目，作为个人侧追问点来源。

Success criteria:

- 两个工件完整可用，方向校验通过，已列出个人侧可追踪的缺口条目。

### 2. 提取共性考察主题

- 从 entry_requirements_report 的任职条件、进入路径、阶段要求中提取最可能被考察的共性主题，如知识、技能、经历、动机和项目理解。
- 只保留工件中有证据支持的主题；无法追溯的主题标注为 model_derived，不得伪装成官方或权威结论。
- 每个主题记录对应的 source_ref 字段。

Success criteria:

- 得到一组可追溯到 entry_requirements_report 条目的考察主题。

### 3. 映射个人相关追问点

- 将 evidence_gap_analysis 中标记为 partial、uncertain 或差距的条目映射为具体问题，例如对项目细节、实验设计、失败原因或指标解释的追问。
- 每个映射写明可能被问的原因：证据不足、表述模糊，或与进入要求直接相关。
- 证据缺口与问题之间必须一一对应，不能凭空添加用户没有暴露的缺口。

Success criteria:

- 所有个人相关追问点都能回溯到 evidence_gap_analysis 的具体条目。

### 4. 生成问题清单与准备要点

- 按步骤 2 的主题分组组织结果，每组包含问题文本、可能被问原因、参考答案思路、与个人证据的关联、需要补充的准备。
- 参考答案思路只能引用 evidence_gap_analysis 或 entry_requirements_report 中已有的证据；不得编造个人经历或外部市场事实。
- 对只能靠共性要求推断而用户证据不明的问题，标注 likelihood 与 confidence 并说明待验证。

Success criteria:

- 每个问题条目五项字段齐全，且答案思路和证据关联都有工件引用。

### 5. 结构校验并返回结果

- 确认输出是包含 likely_question_guide 键的 object，所有问题条目都含必须字段。
- 确认整个执行过程没有调用任何额外工具。
- 调用 ReturnSkillResult 一次并携带完整结果。

Success criteria:

- 输出结构完整、可通过 JSON 校验，用户可直接消费。

## Decision rules

- 问题排序：优先 evidence_gap_analysis 中直接标记为高风险差距或不确定的条目，其次是与用户已有证据相关的共性要求主题，最后是一般进入要求主题。
- 证据引用：每个问题的参考答案思路只能引用两个工件中的条目；无法引用时该字段填 null 并在准备建议中说明。
- 不确定性分级：问题证据来自 entry_requirements_report 共性要求且无个人证据支撑时，标记为 common_likelihood 且 low 或 medium confidence；不得断言用户会被问。
- 未验证项处理：evidence_gap_analysis 中无可靠证据的维度只能转化为可选准备点，不能转化为能力结论。

## Outcome rules

### Success

- evidence_gap_analysis 与 entry_requirements_report 均存在且方向一致
- 至少生成一个按主题分组的问题条目，且每项包含原因、答案思路、证据关联和准备建议

### Insufficient input

- evidence_gap_analysis 或 entry_requirements_report 缺失
- target_direction 与 entry_requirements_report 的目标方向语义不一致
- 两个工件中没有任何可提取的考察主题或证据缺口

### Error

- 输出无法被序列化为带 likely_question_guide 字段的 object
- 问题条目缺少必须字段且无法校验
- 调用 ReturnSkillResult 前发现存在未授权的工具调用


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "likely_question_guide": {
    "type": "object",
    "description": "按主题分组的问题清单，每项给出可能被问的原因、参考答案思路、与个人证据的关联和需要补充的准备"
  }
}
```

Declared consumers:
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- evidence_gap_analysis 与 entry_requirements_report 均至少各被映射到一条问题。
- 每个问题条目包含 question、why_likely、answer_approach、evidence_link、preparation 五个字段。
- 结果中没有出现用户一定或肯定不会问、用户适合或不适合该岗位等绝对化表述。
- 执行过程未调用 WebSearch、WebFetch、Read 或其他额外工具。
- 已调用 ReturnSkillResult 一次且没有后置补充指引。
