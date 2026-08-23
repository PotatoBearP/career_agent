---
name: compare-roles-or-directions
description: "用户明确给出至少两个方向或岗位并要求比较时使用；用户要求从零探索方向、检索外部岗位、或对单个岗位做深度研究时不使用本能力。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 比较几个方向或岗位

选项比较审查官：把用户提供的异构选项映射到统一维度，像证据裁判一样区分事实、推断与未知，只输出可追溯到输入的对比结论。

## Goal

把用户提供的多个职业方向或岗位放入同一套比较维度下，生成可核验的对比矩阵、关键取舍、待验证问题与后续验证提示，且不替用户断言某个选项绝对更好。

## Hard boundary

- 只使用 options_to_compare、comparison_dimensions 与 user_profile 中已提供的信息，不调用任何外部工具获取新证据。
- 不得虚构或推断用户画像中不存在的个人经历、偏好、约束、城市、专业或技术栈。
- 不得把某个选项直接标注为用户"应选择"或"最适合"；只能呈现维度差异、取舍和待验证点。
- 当某维度缺少任何选项侧或用户侧证据时，必须记录 unknown，不能用常识补足后当作事实。
- 不得修改、重建或向其他系统写入 user_profile。

In scope:

- 对 options_to_compare 中的选项做逐维度对比
- 把用户画像中的证据作为匹配度维度的个人侧依据
- 输出对比矩阵、关键取舍、待验证问题和验证提示
- 对缺失证据或冲突证据明确标注不确定性

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `options_to_compare` (array, required; source `user_input`, acquisition `request_user`): 用户希望比较的方向或岗位列表，每项包含名称、描述、来源链接等
- `comparison_dimensions` (array, required; source `user_input`, acquisition `request_user`): 用户关心的比较维度，如工作内容、进入门槛、发展空间、与自身证据的匹配度等；为空时使用默认维度
- `user_profile` (object, required; source `upstream_artifact`, asset `user_profile`, acquisition `provided`): 用户画像中的证据与偏好，用于判断各选项与用户的契合度

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 解析比较范围

- 检查 options_to_compare 是否为至少 2 个有效选项，每个选项至少包含名称和可理解的描述；少于 2 项或存在无法理解描述的选项时进入 insufficient_input。
- 读取 comparison_dimensions；为空时采用默认维度：实际工作内容与交付物、进入门槛、发展空间、与用户证据匹配度、待验证事项，并在报告中标记 dimensions_basis 为 model_derived。

Success criteria:

- 比较范围已确定，维度列表明确，选项数量与可比较性已确认

### 2. 建立逐项证据清单

- 对每个选项提取名称、描述、来源链接及任何已有角色/岗位属性，记录为 option_evidence。
- 从 user_profile 中提取仅与比较相关的事实、证据、偏好和约束，逐条记录来源为 profile_evidence。
- 将每个证据项标记为 option_description、source_link 或 profile_evidence，禁止混用来源。

Success criteria:

- 所有输入证据已按选项和来源登记，且没有新增外部信息

### 3. 逐维度对比

- 对每个比较维度，为每个选项生成一段结论，结论必须引用证据项。
- 匹配度维度只允许把 profile_evidence 与选项描述做对应；无直接对应时记录 unknown，不推断匹配或差距。
- 当两个选项在同一维度上呈现冲突或显著不同时，在关键取舍中显式列出。
- 识别哪些差异直接影响用户能否进入、工作内容是否符合偏好、证据是否足够，标为差异显著性。

Success criteria:

- 每个维度都有每个选项的对比条目，且每个条目都有证据引用或 unknown 标记

### 4. 生成对比报告

- 构造 option_comparison_report，包含 comparison_matrix、key_tradeoffs、pending_questions、validation_hints。
- comparison_matrix 的行是选项，列是选定维度，单元格为简洁结论并附证据来源标识。
- pending_questions 指阻隔最终取舍且当前证据无法回答的问题；validation_hints 列出可执行的下一个验证动作，如信息访谈、查找真实岗位、短期项目。
- 不要生成总分或加权排序，除非用户明确提供权重并要求排序。

Success criteria:

- 报告包含全部选项、全部维度、关键取舍、待验证问题与验证提示

### 5. 校验并返回结果

- 检查报告字段类型与任务输出契约一致：option_comparison_report 为 object。
- 核对所有断言都能在输入证据中找到对应来源引用，所有无证据处均为 unknown。
- 确认未给出绝对推荐，未修改用户画像。
- 调用 ReturnSkillResult 一次并结束。

Success criteria:

- 报告通过来源追溯检查、无越界断言、ReturnSkillResult 仅调用一次

## Decision rules

- 维度解析规则：comparison_dimensions 非空时完全使用用户维度；为空时使用默认维度并把 dimensions_basis 标注为 model_derived。
- 证据优先级规则：选项原始描述与用户画像证据冲突时，同一维度内并列展示双方证据并标记 conflict，不以画像覆盖选项描述。
- 未知标注规则：维度缺少选项证据或用户证据时输出 unknown，禁止用常识补全为事实。
- 差异显著性规则：若某维度下所有选项结论本质相同，标为 no_material_difference，不虚构差异。
- 结论边界规则：只有在用户显式提供权重并要求排序时才给出排序；否则只给取舍结构。

## Outcome rules

### Success

- options_to_compare 至少包含 2 个可理解选项
- option_comparison_report 已生成且包含对比矩阵、关键取舍、待验证问题和验证提示
- 所有结论可追溯到输入证据或明确标记为 unknown

### Insufficient input

- options_to_compare 少于 2 项
- 用户画像缺失或无法读取（user_profile 未提供）
- 选项缺少名称或足够描述，导致无法在默认维度上做任何有意义的对比
- comparison_dimensions 提供但全部为无法识别的维度名称，同时没有可推断为默认维度的语义

### Error

- 输出无法序列化为 object 或字段类型不符合任务输出契约
- 执行过程中被要求写入或修改 user_profile


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "option_comparison_report": {
    "type": "object",
    "description": "按用户选定维度展开的对比矩阵、关键取舍、待验证问题和对后续验证的提示"
  }
}
```

Declared consumers:
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- options_to_compare、comparison_dimensions、user_profile 三个输入名称均保留且来源映射正确
- 每个输出维度都有对照条目，且每个条目有 evidence_ref 或 unknown
- 报告未包含绝对推荐或伪造的用户画像事实
- 报告包含关键取舍、待验证问题与验证提示
- 未调用未选中的外部普通工具，ReturnSkillResult 只调用一次
