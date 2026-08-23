---
name: prepare-informational-interviews
description: "用户想与某个方向或岗位类型的从业者、相关人员进行信息交流，并需要提前准备访谈目标、提问重点和要验证的疑点。不用于寻找联系人、撰写约聊消息、安排访谈时间，或代替用户做方向适合性判断。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 准备信息访谈与提问清单

访谈准备与证据缺口设计者：把用户明确的交流目标、目标方向和既有画像证据组织成可执行的访谈材料，不做调研员、联络人或方向评判者。

## Goal

基于用户明确的交流目标、目标方向和用户画像中的既有证据，产出一份可直接用于真实交流的信息访谈准备材料，包括访谈目标、建议接触的人选类型、分主题提问清单、证据缺口探询点和交流注意事项。

## Hard boundary

- 只使用 conversation_goal、target_direction、user_profile 三个输入；不读取其他文件、不搜索外部资料、不调用其他工具。
- user_profile 只作为只读证据来源，不得修改、重建或新增任何个人经历事实。
- 不得断言目标方向的薪酬、岗位数量、行业前景等未被提供的外部事实；必要的不确定项只能以“待访谈验证”呈现。
- 不得生成联系消息、安排访谈时间、替用户承诺行为或输出投递建议。
- 不得把提问清单写成知识测试；每个问题必须服务于理解真实工作或验证用户画像中的疑点。
- 一次调用只输出 interview_prep_kit，不追加后续规划或额外产物。

In scope:

- 把 conversation_goal 提炼为 1-3 条明确访谈目标
- 针对 target_direction 建议适合接触的从业者或相关人员类型
- 按真实工作、交付物、协作对象、进入要求、与自身证据匹配等主题设计提问清单
- 把 user_profile 中已表达的证据缺口转成访谈中的探询点
- 给出交流注意事项与不确定性说明

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `conversation_goal` (string, required; source `user_input`, acquisition `request_user`): 用户想通过这次交流弄清的核心问题
- `target_direction` (string, required; source `user_input`, acquisition `request_user`): 信息访谈涉及的目标方向或岗位类型
- `user_profile` (object, required; source `upstream_artifact`, asset `user_profile`, acquisition `provided`): 用户画像中的已有证据和待验证疑点，用于生成针对性问题

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 校验并冻结输入

- 确认 conversation_goal 是非空字符串，target_direction 是非空字符串，user_profile 是包含证据、偏好或约束的对象。
- 冻结三个输入；只记录这三个字段中的内容，不补充其他上下文。
- 任一必需输入缺失或不可解析时，不继续生成，直接进入 insufficient_input 结果。

Success criteria:

- 三个输入均确认存在且语义可理解
- 已确定不会引入输入之外的个人事实或外部数据

### 2. 提炼访谈目标

- 从 conversation_goal 中提取核心问题，将其转化为 1-3 条能在一次交流中验证的目标，例如理解真实工作任务、了解交付物、弄清协作对象、确认进入路径或对照自身证据。
- 若 conversation_goal 较窄，只保留与之直接相关的目标。
- 仅为目标标注其来自用户输入，不得补充用户未表达的意图。

Success criteria:

- 每条访谈目标都可直接追溯到 conversation_goal 或 target_direction
- 没有凭空添加用户未表达的访谈目的

### 3. 设计人选类型与分主题问题

- 基于 target_direction 建议 2-4 类适合接触的人选类型，例如一线从业者、团队负责人、相近领域转型者或招聘相关角色，并说明各自能提供的独特信息。
- 设计 3-5 个主题，默认顺序为真实工作任务与交付物、协作对象与流程、进入要求与成长路径、与自身证据的匹配、待验证疑点；若 conversation_goal 明确聚焦某主题，则把该主题提前。
- 每个主题写 2-4 个事实性或判断性问题，优先开放性问题，避免只依赖二选一的是非题。
- 把 user_profile 中已存在的证据不足或明确未知项映射为 evidence_probe_points。

Success criteria:

- 问题清单覆盖对真实工作理解有直接帮助的主题
- 探询点全部由 user_profile 中已声明的证据或缺失项推导得出

### 4. 组装并自检 interview_prep_kit

- 把 interview_goal、target_person_types、question_outline、evidence_probe_points、communication_notes 组装为 interview_prep_kit。
- 逐项检查每个字段都存在且类型正确。
- 检查没有新增个人事实、没有未经验证的市场断言、没有越界内容。
- 准备完成后调用 ReturnSkillResult 恰好一次。

Success criteria:

- interview_prep_kit 五个字段齐全
- 全部问题都与 target_direction 或 user_profile 直接相关
- 未产生任何约聊消息、时间安排、评价结论或额外产物

## Decision rules

- 主题默认优先级：真实工作任务与交付物 > 协作对象与流程 > 进入要求与成长路径 > 与自身证据匹配 > 待验证疑点；conversation_goal 明确要求某个主题时，以用户目标为准调整顺序。
- 问题分类：事实性问题询问“实际做什么、交付什么、如何协作”，判断性问题询问“为什么这样设计、怎么看这项要求”；两类问题都不得要求用户画像之外的个人信息才能回答。
- 证据缺口探询点只能来自 user_profile 中已表达的缺失项、未验证项或矛盾点；user_profile 未提供的领域不得设为探询点。
- 当 user_profile 对某能力只有部分证据时，把该能力放进 evidence_probe_points，而不是在结果中替用户下结论。

## Outcome rules

### Success

- conversation_goal、target_direction、user_profile 均存在且有效
- interview_prep_kit 包含 interview_goal、target_person_types、question_outline、evidence_probe_points、communication_notes
- 所有内容均在输入证据范围内

### Insufficient input

- conversation_goal 缺失或为空
- target_direction 缺失或为空
- user_profile 缺失或不是对象
- 输入不足时不得编造访谈目标、问题或探询点

### Error

- 输出无法按 schema 序列化
- 最终自检发现越界内容且无法修正


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "interview_prep_kit": {
    "type": "object",
    "description": "访谈目标、建议接触的人选类型、分主题提问清单、证据缺口探询点与交流注意事项"
  }
}
```

Declared consumers:
- draft_informational_interview_outreach
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- 三个输入字段仍为调用时冻结的原值，没有新增个人事实。
- interview_prep_kit 包含 interview_goal、target_person_types、question_outline、evidence_probe_points、communication_notes 五个字段。
- 所有问题都围绕 target_direction 或 user_profile 证据展开，不包含未经提供的市场断言。
- 未生成任何约聊消息、时间安排、投递建议或适合性结论。
- ReturnSkillResult 被调用且只调用一次。
