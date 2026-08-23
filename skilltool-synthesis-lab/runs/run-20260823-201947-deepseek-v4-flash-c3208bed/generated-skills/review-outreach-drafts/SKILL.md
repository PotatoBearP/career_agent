---
name: review-outreach-drafts
description: "仅在用户已经拿到联系消息草稿、准备在发送前做一次检查时触发，例如用户说“我准备发这条消息了，帮我看看有没有不妥”“帮我检查一下这几版消息哪句容易被误会”“这条私信会不会太冒昧”。当用户要求新写消息、重新核实人脉线索、安排发送时间或实际发送消息时不要使用本能力。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 外联消息适宜性审核

发送前消息风控审查员：只对已注入的草稿、用户规则和核验事实做对照判断，不采集新证据、不发送消息、不改写原文。

## Goal

对用户拟发送的联系消息草稿逐条做发送前检查，标出可能让人不舒服、越界、夸大关系、泄露隐私、语气不当或与已核验事实不符的位置，给出具体风险和改写建议，并明确提示发送前必须由用户确认的范围。

## Hard boundary

- 不得发送、投递、撤回或修改任何外部系统状态，也不得生成可被直接发送的最终文案并声称已发送。
- 不得修改 contact_message_drafts 中的原文；所有修改只能以 revision_suggestion 形式输出。
- 不得把 network_lead_verification_report 中未覆盖的内容当作已核验事实；未覆盖一律标记 unverified。
- 不得虚构共同经历、熟人背书、已获得推荐或对方身份；消息中出现此类主张而输入无法支持时，必须标记 unsupported_claim。
- 不得使用 WebSearch、WebFetch 或任何工具补充信息；只消费输入快照。
- 不得把用户画像、岗位材料或其他上游产物作为额外检查依据；只使用本能力声明的输入。
- 不得在多个草稿之间互相推断关系或事实。

In scope:

- 检查每条联系消息草稿的内容风险
- 对照用户联系规则识别隐私、渠道、称呼和越界问题
- 对照消息偏好识别语气、长度、用词问题
- 对照人脉线索核验报告识别与事实不符或无法核实的主张
- 为每条风险标注问题位置、风险类型、具体风险和改写建议
- 标记哪些事项在发送前必须由用户确认

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `contact_message_drafts` (array, required; source `prior_skill_output`, asset `contact_message_drafts`, acquisition `prior_skill`): 用户已有产物，是针对不同联系场景生成的待发送消息草稿
- `user_contact_rules` (object, required; source `user_input`, acquisition `request_user`): 用户对隐私、可透露信息、称呼方式和不想越过的界限的说明
- `message_preferences` (object, required; source `user_input`, acquisition `request_user`): 用户偏好的语气、长度、用词习惯和希望避免的表达
- `network_lead_verification_report` (object, required; source `prior_skill_output`, asset `network_lead_verification_report`, acquisition `prior_skill`): 用户已有产物，是待联系对象与渠道的事实核实结果，用于检查消息里有没有与事实不符的说法

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 加载并校验输入快照

- 读取 contact_message_drafts、user_contact_rules、message_preferences、network_lead_verification_report 四个输入。
- 确认 contact_message_drafts 是非空数组且每条草稿含 draft_id 与正文；确认 user_contact_rules、message_preferences 是非空对象；确认 network_lead_verification_report 是可供查询的对象。
- 若任一必需输入缺失、为空或结构不可解析，停止并返回 insufficient_input，不得继续生成检查意见。

Success criteria:

- 四个输入均已加载且结构可解析
- 能够为每条草稿确定 draft_id、contact_id 和 target_opportunity_id

### 2. 建立检查基线

- 从 user_contact_rules 提取禁止项：不可透露信息、不可使用渠道、不想打扰对象、称呼边界、隐私边界。
- 从 message_preferences 提取语气、长度、用词偏好与希望避免的表达。
- 把规则冲突顺序固定为：user_contact_rules 的禁止项优先于 message_preferences 的偏好；message_preferences 的偏好优先于一般性建议。
- 定义风险分级：factual_discrepancy、privacy_leak、boundary_violation、unsupported_claim 为阻塞级；tone_mismatch、intent_unclear 为建议级。

Success criteria:

- 已得到规则清单与禁止项清单
- 已确定每个风险类别的阻塞/建议级别

### 3. 构建核验事实映射

- 逐条读取 network_lead_verification_report 中 lead_id、verification_grade、evidence_source、organization、role、relationship 等已核验字段。
- 按 contact_id 或 lead_id 建立「哪些事实已核验、哪些未覆盖」的映射。
- 对每条草稿，确定其消息中出现的组织、身份、共同点、关系、推荐等事实性主张属于已核验、与核验冲突、还是未覆盖。

Success criteria:

- 每个草稿涉及的联系人都能在核验报告或草稿自身中找到对应标识
- 事实主张都能归类为 verified、conflicts、uncovered 三者之一

### 4. 逐条草稿执行风险扫描

- 对每条草稿按固定顺序检查：事实一致性、关系真实性、隐私边界、渠道与权限边界、语气与长度、来意清晰度。
- 事实一致性：若草稿主张与 network_lead_verification_report 冲突，标记 factual_discrepancy；若报告未覆盖，标记补充说明为 unverified 而非断言。
- 关系真实性：若草稿暗示共同经历、熟人背书或已获推荐而输入无证据，标记 unsupported_claim。
- 隐私边界：若草稿包含 user_contact_rules 禁止透露的信息，标记 privacy_leak。
- 渠道与权限边界：若草稿暗示绕过平台权限、批量群发、索要私人联系方式或施压，标记 boundary_violation。
- 语气与长度：若与 message_preferences 不符，标记 tone_mismatch 并说明具体偏差。
- 来意清晰度：若未说明真实来意或未给出可回应点，标记 intent_unclear。
- 每条风险记录 flagged_text 的原文位置和可执行的 revision_suggestion。

Success criteria:

- 每条草稿返回至少一条检查结论，可为无风险
- 所有 flag 均包含 draft_id、risk_flag_type、flagged_text、risk_description、revision_suggestion

### 5. 判定发送就绪与确认要求

- 若某条草稿存在任一阻塞级 flag，overall_verdict 设为 needs_revision 且 confirmation_required=true。
- 若只有建议级 flag，overall_verdict 设为 review_advisory 且 confirmation_required=false，但发送前仍提示用户可自行取舍。
- 若无 flag，overall_verdict 设为 ready_after_confirmation，confirmation_required=false，同时保留“发送前请用户确认目标、内容和范围”的提示。
- 按 draft_id|risk_flag_type|flagged_text|revision_suggestion 去重，阻塞级 flag 排在建议级之前。

Success criteria:

- 每条草稿都有确定的 overall_verdict 与 confirmation_required
- flag 列表去重且排序符合规则

### 6. 组装检查意见并返回

- 生成 message_review_notes 对象：reviewed_at、draft_reviews、summary。
- summary 汇总阻塞级 flag 数、建议级 flag 数、可直接发送条目数和必须确认条目数。
- 调用 ReturnSkillResult 一次，返回该对象；不要在返回后追加发送建议或代用户发送。

Success criteria:

- 输出对象可被标准 JSON 解析且字段与 schema 一致
- draft_reviews 覆盖输入的全部草稿
- 已调用且仅调用一次 ReturnSkillResult

## Decision rules

- 风险分级固定：factual_discrepancy、privacy_leak、boundary_violation、unsupported_claim 为阻塞级；tone_mismatch、intent_unclear 为建议级。
- 核验报告未覆盖的事实一律标记为 unverified，不能作为支持或否定草稿主张的依据。
- user_contact_rules 的禁止项优先于 message_preferences；任何偏好都不能覆盖隐私或边界禁止项。
- 同一草稿存在阻塞级 flag 时，整体 verdict 为 needs_revision，即使同时存在建议级 flag。
- 同一位置多个同类型风险合并为一条 flag，flagged_text 取最小可定位片段。
- 若草稿无任何事实性主张，则不生成 factual_discrepancy；若输入中完全没有核验事实可供对照，则只能按 uncovered 处理并在 summary 中说明局限。

## Outcome rules

### Success

- 至少存在一条可解析的联系消息草稿
- 所有输入均可用且结构完整
- 输出 message_review_notes 覆盖全部草稿并包含逐条 verdict 与 flag 列表
- 未执行任何发送或改写原文操作
- 仅调用一次 ReturnSkillResult

### Insufficient input

- None.

### Error

- None.


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "message_review_notes": {
    "type": "object",
    "description": "逐条消息标出的问题位置、问题类型、具体风险和改写建议，并提示哪些地方需用户确认后才能发送"
  }
}
```

Declared consumers:
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- None.
