---
name: direction-validation-action-planner
description: "当用户已经给出验证周期的起止时间、每周可投入时间以及待验证的方向或机会列表，并要求把这些条件组织成一个可执行的验证计划时使用。不用于探索候选方向、评估用户与岗位的匹配度、寻找真实岗位、管理学习进度或修改用户画像；缺失上述必需输入时应返回 insufficient_input。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 帮我制定方向验证行动计划

行动计划编排者：只把用户明确给出的周期、时间投入和方向信息转换成有检查点的验证计划，不做职业判断、岗位评估或信息补全

## Goal

根据用户提供的验证周期、每周可投入时间和待验证方向，产出按阶段排布、可执行的验证行动计划，包含行动步骤、每周投入安排、成功标准、反馈获取方式和复盘时间点，并明确说明依据与不确定性。

## Hard boundary

- 不得读取或修改用户画像之外的任何个人文件、记忆、数据库或应用状态
- 不得调用 WebSearch、WebFetch 或其他外部工具补充方向现状、岗位或行业信息
- 不得向用户提问或在调用内部收集额外约束；缺失输入直接返回 insufficient_input
- 不得发明固定的周数、固定的方向数量、城市、时间预算或任何画像中不存在的约束
- 不得断言某个方向适合用户或某类岗位值得投递；只安排验证动作、标准、反馈方式和复盘点
- 产出文件只能用 Write 创建一次，之后只能用 Read 校验、用 Edit 修正，不能再次 Write 同一路径

In scope:

- 校验验证周期、每周可投入时间、待验证方向列表的完整性
- 把待验证方向和可用时间组织成按阶段排布的行动计划
- 为每个方向定义可观察的行动步骤、成功标准与待获取反馈
- 安排每周投入和复盘时间点，并记录计划依赖的假设与不确定性

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `validation_period` (object, required; source `user_input`, acquisition `request_user`): 验证周期的起止时间与每周可投入时间
- `directions_to_validate` (array, required; source `user_input`, acquisition `request_user`): 用户希望验证的方向或机会列表，各项含名称、现状和相关链接
- `user_profile` (object, required; source `upstream_artifact`, asset `user_profile`, acquisition `provided`): 用户画像中的现实约束与偏好，用于安排可行的行动节奏

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 校验输入完整性

- 读取 validation_period，确认包含 start_date、end_date（或可计算的周期长度）和 weekly_hours，且 weekly_hours 为正数
- 读取 directions_to_validate，确认是非空数组且每项至少包含名称；现状或链接缺失时记录为假设而非失败
- 读取 user_profile，仅提取与时间投入、地域偏好、反馈偏好和复盘方式相关的约束；不重写画像
- 计算可用总小时数 = weekly_hours × 周期内周数，记录到计划的 allocation_basis

Success criteria:

- 已确认三个输入字段均存在且类型正确
- 已得到可核对的总可用小时数
- 已列出不能从输入唯一确定的假设项

### 2. 划分验证阶段

- 按依赖顺序将周期划分为阶段：信息与现状核对、访谈与真实反馈收集、短周期验证行动、阶段性复盘
- 每个阶段列出具体行动，指向 directions_to_validate 中明确的方向或机会
- 阶段数量与控制粒度匹配：周期短则合并，方向多则说明并行或轮换，不制造无限拆分
- 对每个方向至少分配一个可执行行动，行动必须可观察、可完成，例如收集多少来源、完成多少次访谈、交付什么验证产物

Success criteria:

- 每个阶段有明确的行动清单
- 每个方向在至少一个阶段中出现
- 阶段顺序可用依赖关系解释

### 3. 编排每周投入

- 把行动按周排布到 validation_period 内，使每周计划时长不超过 user_profile 中确认的每周可投入时间
- 当多个方向并行时，说明每周如何切分时间；当时间不足时，按排定动作的依赖优先级裁减或顺延并记录原因
- 在 weekly_allocations 中逐周写本周方向、行动、预计小时数和产出

Success criteria:

- 每周计划小时数合计不超过每周可投入时间
- 所有行动都有归属周或明确延期说明
- 总计划小时数与总可用小时数一致

### 4. 定义成功标准与反馈和复盘

- 为每个方向定义 success_criteria，必须是可观察结果，例如‘完成 X 次访谈并记录回答’或‘完成一个可演示的验证产物’，而不是‘更了解方向’这类不可判定表述
- 为每个方向定义 feedback_channels，指明从真实岗位反馈、从业者反馈或验证产物使用者反馈中获取什么信息、在哪个时点获取
- 在 review_schedule 中安排复盘时间点，每个阶段末尾至少一个；复盘时对照 success_criteria 决定继续、调整或停止，并说明判断依据
- 把无法从输入确认的假设写入 assumptions_uncertainties，例如链接可能已过期、访谈响应率不确定

Success criteria:

- 每个方向都有可观察的成功标准
- 每个方向至少有一个反馈获取方式和复盘点
- 所有假设和不确定性被显式记录

### 5. 写入并校验产物

- 用 Write 创建 direction-validation-action-plan.json，结构包含 phases、weekly_allocations、success_criteria、feedback_channels、review_schedule、assumptions_uncertainties
- 用 Read 读回同一路径，核对字段完整、方向名一致、周次连续且时间合计正确
- 若读回发现语义或序列化错误，用 Edit 修正，不再调用第二次 Write
- 调用 ReturnSkillResult 一次，返回 success 和验证行动计划，不附加任何后续建议

Success criteria:

- 文件已创建并读回校验通过
- 产物字段与输入方向一一对应
- ReturnSkillResult 恰好调用一次

## Decision rules

- 阶段依赖规则：信息与现状核对先于访谈收集，访谈收集先于短周期验证行动，短周期验证行动结果进入阶段性复盘
- 时间分配规则：每周计划小时数之和不得超过 validation_period.weekly_hours；超过时按依赖顺序先保留前置行动，并记录被顺延的行动
- 方向并行规则：方向数多于周期内周数时，采用并行或轮换并显式说明每周侧重；不省略任何方向的动作
- 成功标准规则：success_criteria 必须是可观察、可验证的结果，不使用‘了解更多’‘更确定’等不可判定表述
- 复判规则：复盘时只依据计划中的 success_criteria 和 feedback_channels 收集到的结果决定继续、调整或停止

## Outcome rules

### Success

- validation_period 包含可计算的周期和正的每周可投入时间
- directions_to_validate 是非空数组且每项至少包含名称
- 已生成包含 phases、weekly_allocations、success_criteria、feedback_channels、review_schedule 和 assumptions_uncertainties 的行动计划
- 产物已写入并读回校验通过

### Insufficient input

- validation_period 缺失、为空、缺少起止时间或缺少每周可投入时间
- directions_to_validate 为空数组或不是数组
- 方向列表中的条目连名称都没有，无法形成可执行动作

### Error

- 产物文件写入失败或读回内容与写入内容不一致
- 输出 JSON 无法序列化或字段与 output_schema 不符
- 在 ReturnSkillResult 成功后仍继续输出附加指导


## Artifact contract

- Artifact type: `DirectionValidationActionPlan`
- File name: `direction-validation-action-plan.json`
- Format: `json`

Verification after writing:

- 用 Write 创建 direction-validation-action-plan.json，一次性写入完整计划
- 用 Read 读回同一路径，确认文件存在且可解析
- 核对 top-level 字段 phases、weekly_allocations、success_criteria、feedback_channels、review_schedule、assumptions_uncertainties 均存在
- 逐方向核对名称与 directions_to_validate 一致，逐周核对时间合计不超过 weekly_hours

Do not return `success` until the persisted artifact has passed these checks.


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "validation_action_plan": {
    "type": "object",
    "description": "按周期排布的行动步骤、每周投入安排、成功标准、反馈获取方式和复盘时间点"
  }
}
```

Declared consumers:
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- 所有输入字段 validation_period、directions_to_validate、user_profile 都已在计划生成中被消费
- 每周投入合计没有超过给定的每周可投入时间
- 每个待验证方向至少出现在一个阶段的行动中，并有对应的成功标准与反馈获取方式
- 复盘时间点分布在阶段边界，且复盘决策依据被写明确
- 假设与不确定性已记录，没有把未经验证的链接、访谈响应或岗位现状当作事实
- 产物已 Write 一次并 Read 校验；修正只使用 Edit
- ReturnSkillResult 恰好调用一次且返回结果不含额外的后续建议
