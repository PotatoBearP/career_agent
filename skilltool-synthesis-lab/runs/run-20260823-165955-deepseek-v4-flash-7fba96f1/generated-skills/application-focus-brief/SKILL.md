---
name: application-focus-brief
description: "用户准备向某个目标方向或岗位类型投递或展示自己，并已有可用的 evidence_gap_analysis 对照结果时使用。不应在缺少对照结果、缺少用户画像或用户要求重新生成完整简历、求职信或虚构经历时使用。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 投递材料准备要点

投递材料要点的证据裁判与表述策略顾问：只把已有证据映射为突出、弱化、避免和待补充四类结论，不新增个人事实。

## Goal

基于已有的经历与要求对照结果，产出一份面向目标方向的投递材料准备要点，明确定位应当如实突出的已有证据、应当弱化或避免的表达、需要补充的证据以及各处的不确定性。

## Hard boundary

- 不得读取或调用 WebSearch、WebFetch 或其他外部数据源重新收集岗位要求或用户经历
- 不得新增 user_profile 中不存在的个人经历、技能、成果或指标
- 不得断言用户适合某岗位，只能陈述证据与差距
- 不得改写 evidence_gap_analysis 中已给出的匹配状态或不确定性
- 不得输出完整简历、求职信、作品集文案或套话模板

In scope:

- 从 evidence_gap_analysis 中读取逐项匹配状态、证据、差距、不确定性和建议验证
- 从 user_profile 中读取可如实突出的已有事实、证据与偏好
- 给出建议突出、建议弱化或避免、需要补充证据和不确定性说明
- 保证所有结论可追溯到输入证据

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `evidence_gap_analysis` (object, required; source `prior_skill_output`, asset `evidence_gap_analysis`, acquisition `prior_skill`): 已有经历与目标方向要求的逐项对照结果，作为生成投递重点的基础
- `target_direction` (string, required; source `user_input`, acquisition `request_user`): 要准备投递或展示的目标方向或岗位类型
- `user_profile` (object, required; source `upstream_artifact`, asset `user_profile`, acquisition `provided`): 用户画像中的已有证据与偏好，用于确认哪些经历可以如实突出

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 校验输入并界定证据边界

- 确认 evidence_gap_analysis、target_direction、user_profile 均非空且可解析
- 确认 evidence_gap_analysis 中至少存在一条可识别的逐项匹配记录；否则按 insufficient_input 返回
- 冻结输入为本次调用的唯一证据来源

Success criteria:

- 三个输入都存在且可读
- evidence_gap_analysis 可被拆解为逐项条目
- 未调用任何外部工具

### 2. 解析逐项匹配状态

- 逐项读取匹配状态、直接证据、部分证据、差距、不确定性和建议补充的验证
- 将每条要求归入 direct_evidence、partial_evidence、gap、unknown 四类
- 保存每条结论对应的 evidence source 标识，用于 source_basis

Success criteria:

- 所有条目都被归入四类之一
- 每条结论都保留可追溯来源
- 没有丢弃 evidence_gap_analysis 中的不确定性字段

### 3. 生成建议突出项

- 仅从 user_profile 中已有证据中挑选与 direct_evidence 匹配的经历作为 suggest_highlights
- 对于 partial_evidence，只能以限定范围的方式列入，并在描述中注明证据边界
- 若某条直接证据在 user_profile 中找不到对应事实，则不得列入突出项

Success criteria:

- 每个突出项都能在 user_profile 中找到原始事实
- 每个 partial 突出项都附带范围限定
- 没有来自 gap 或 unknown 条目的突出项

### 4. 生成建议弱化与避免项

- 将 partial_evidence 中容易产生过度解读的内容列入 suggested_deemphasis，并说明应限制到什么程度
- 将 user_profile 中无证据支持的能力主张、与 direct_evidence 矛盾的表述、以及暗示生产部署、多人协作、真实用户、业务指标或正式流程的未经证实说法列入 suggested_avoid
- 为每项避免项写明对应的缺失证据

Success criteria:

- 每个 deemphasis 和 avoid 项都对应明确的证据状态
- 没有把尚无可靠证据的维度写成已有能力
- 没有输出绝对化或夸大性措辞建议

### 5. 整理待补充证据与不确定性

- 把 gap 和 partial_evidence 条目转化为 evidence_to_supplement，每项给出可验证的补证方向（如短期项目、可展示实验、信息访谈确认）而非虚构结果
- 把证据不足、来源单一或相互矛盾的条目写入 uncertainty_notes
- 保持 evidence_gap_analysis 中的原不确定性表述，不自行降低或消除不确定性

Success criteria:

- 每个 gap 都被列为待补充证据或不确定性
- 每个 uncertainty_notes 条目都有据可查
- 没有把待补充事项表述为已完成事实

### 6. 组装并返回结果

- 按 output_schema 组装 application_focus_brief 对象
- 写入 source_basis，说明每个突出、弱化、避免、待补充结论分别来自 evidence_gap_analysis 的哪类信息与 user_profile 的哪些事实
- 调用 ReturnSkillResult 返回对象并结束

Success criteria:

- 输出对象包含 target_direction、suggested_highlights、suggested_deemphasis、suggested_avoid、evidence_to_supplement、uncertainty_notes、source_basis
- 无多余个人事实
- 已调用并且只调用一次 ReturnSkillResult

## Decision rules

- 匹配状态 direct_evidence 且证据存在于 user_profile → 可列入 suggested_highlights
- 匹配状态 partial_evidence → 仅以限定范围列入 suggested_highlights，同时进入 suggested_deemphasis 说明限制方式
- 匹配状态 gap 或 unknown → 不得列入 suggested_highlights，进入 evidence_to_supplement 或 uncertainty_notes
- user_profile 中没有可靠证据的任何生产部署、多人协作、真实用户、业务指标或正式开发流程表述 → 列入 suggested_avoid
- evidence_gap_analysis 与 user_profile 对同一能力的表述冲突 → 采用更保守的解读并写入 uncertainty_notes
- 当 evidence_gap_analysis 中某条证据只来自单一来源或来源时效不明 → 在 uncertainty_notes 中标注 low confidence，不改变匹配状态

## Outcome rules

### Success

- evidence_gap_analysis、target_direction、user_profile 均存在且可解析
- evidence_gap_analysis 中至少存在一条可归类的匹配记录
- 输出 application_focus_brief 对象且包含全部必需字段
- 所有结论均可追溯到 user_profile 或 evidence_gap_analysis

### Insufficient input

- target_direction 为空或缺失
- evidence_gap_analysis 缺失、为空或无法解析出任何逐项匹配记录
- user_profile 缺失或其中没有任何可用于支撑突出项的事实

### Error

- 证据输入格式损坏导致无法稳定解析
- 输出序列化失败或 ReturnSkillResult 调用失败


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "application_focus_brief": {
    "type": "object",
    "description": "针对目标方向的材料重点，包括建议突出的经历、建议弱化或避免的表达、待补充证据和不确定性说明"
  }
}
```

Declared consumers:
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- 检查输出的每个 highlighted 项都有 user_profile 中的原始事实支撑
- 检查每个 deemphasis/avoid 项都对应明确的证据缺口或匹配状态
- 检查没有出现 user_profile 中不存在的经历、成果或指标
- 检查 gap 条目都已进入 evidence_to_supplement 或 uncertainty_notes
- 检查未调用任何 Web 或文件工具
- 检查 ReturnSkillResult 只被调用一次
