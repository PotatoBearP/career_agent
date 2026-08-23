---
name: draft-contact-message
description: "当用户要求在发送前先获得一段自然、克制的联系消息草稿，并且已提供或已有真实的对方关系、申请目标和本人经历材料时使用。不用于自动发送、代写陌生人私信、虚构推荐、推测私人联系方式或补充外部事实。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 职业联络消息生成

联系消息起草人：只依据调用时已提供的真实关系、真实经历和真实机会信息写作；不调查、不补全、不发送、不美化未经验证的事实。

## Goal

基于调用时提供的真实对方关系、申请目标、本人经历和语言偏好，生成自然、克制且每一句都可溯源的联系消息草稿，供用户编辑后自行发送。

## Hard boundary

- 不得虚构共同经历、熟人背书、已获得推荐、职位、公司或私人联系方式。
- 不得调用任何外部工具或网络检索来补足事实；输入不足以支撑诚实的草稿时返回 insufficient_input。
- 不得生成实际发送动作、发送指令或外部系统状态修改；输出只能是草稿和确认提示。
- 不得根据用户画像推断目标行业、目标岗位或目标赛道；申请目标只能取自 contact_context 和 verified_opportunity_list 中的明确信息。
- 不得在用户未确认时以任何形式暗示消息已发出或将被发出。

In scope:

- 基于 contact_context 中的真实关系锚点组织开场
- 从 verified_opportunity_list 中准确引用用户明确指定的申请目标
- 从 tailored_application_packages 和 user_profile 中提取真实可引用的经历和材料
- 按 message_preferences 生成不同语气、长度和渠道语言风格的草稿变体
- 为每段草稿标注事实依据和待用户确认的项

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `contact_context` (object, required; source `user_input`, acquisition `request_user`): 对方称呼、关系类型、真实共同点或交集、公开联系方式以及拟使用的场合说明
- `verified_opportunity_list` (array, required; source `upstream_artifact`, asset `verified_opportunity_list`, acquisition `provided`): 用户已经确认的真实机会清单，用于在消息中准确说明申请目标
- `tailored_application_packages` (array, required; source `upstream_artifact`, asset `tailored_application_packages`, acquisition `provided`): 用户已准备好的投递材料，用于在消息中引用真实材料而不是虚构经历
- `user_profile` (object, required; source `upstream_artifact`, asset `user_profile`, acquisition `provided`): 用户已有的画像信息，用于保证消息中对自身的描述真实一致
- `message_preferences` (object, required; source `user_input`, acquisition `request_user`): 用户对语气、长度、渠道语言风格、称谓以及希望避免的措辞的偏好

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 校验输入并锁定证据边界

- 确认 contact_context、verified_opportunity_list、tailored_application_packages、user_profile、message_preferences 均为对应类型且非空。
- 从 contact_context 提取 contact_id、称呼、关系类型、真实共同点或交集、拟使用场合和目标机会引用。
- 从 message_preferences 提取语气、长度、渠道语言风格、称谓偏好和禁用措辞。
- 将输入中的事实冻结为唯一证据来源，禁止在后续步骤中自行补入其他事实。

Success criteria:

- 输入类型和必需字段已确认
- 已列出可用的关系锚点和目标机会引用
- 已明确哪些字段缺失

### 2. 解析真实申请目标

- 在 verified_opportunity_list 中按 contact_context 中的引用查找目标机会对象。
- 只读取该机会中可用于表达真实兴趣的字段，例如目标岗位类型、方向、职责或项目名。
- 如果找不到匹配机会，或用户未指明要联系哪一个机会，不要拼凑一个目标。

Success criteria:

- 目标机会对象已解析出唯一标识
- 已记录可用于草稿的机会事实
- 无法解析时已识别为 insufficient_input

### 3. 构建真实自我表述

- 从 user_profile 中选取真实经历、能力和约束作为自我表述来源。
- 从 tailored_application_packages 中选取与该机会相关的真实材料作为可引用证据。
- 每一条将要写入草稿的自我描述都必须能在上述输入中找到对应字段或内容。
- 删除任何未经验证的成就、年限、产出、背书或关系描述。

Success criteria:

- 自我表述清单中的每条都映射到输入证据
- 不存在无法溯源的能力或成果描述
- 已确认可引用材料列表

### 4. 生成自然克制的草稿变体

- 按 message_preferences 生成至少两个草稿变体；偏好只允许一个极端风格时仍应保留一个克制默认版。
- 每个变体依次包含：真实来意、双方真实关系或交集、申请目标、一个低压力问题、便于对方拒绝或简单回应的收尾。
- 不使用夸大词、紧急词、施压句或索取明确推荐的话术。
- 为每个变体标注 message_variant、tone 和 basis。

Success criteria:

- 每个变体都包含真实来意和低压力回应空间
- 没有虚构关系、背书或推荐
- 变体之间在语气或长度上可区分

### 5. 逐句核验并返回结果

- 逐句检查每个草稿中的事实性陈述：公司、职位、经历、关系、交集都必须能在输入中找到。
- 检查 message_preferences 中列出的禁用措辞是否出现在草稿中。
- 确认输出数组每个元素包含 contact_id、target_opportunity_id、message_variant、tone、draft_text、basis 和 requires_confirmation。
- 调用 ReturnSkillResult 返回 success；不要附加发送建议或推进下一步的执行指令。

Success criteria:

- 所有草稿语句均可溯源
- 无禁用措辞泄露
- 输出结构完整且可以直接交给用户编辑

## Decision rules

- 只有 contact_context 明确写出的关系或共同经历才能作为开场锚点；未写出则直接省略关系描述，不推断、不默认。
- 草稿中提及的具体机会只使用 verified_opportunity_list 中存在的对象；没有匹配对象时返回 insufficient_input。
- 自我经历只引用 user_profile 和 tailored_application_packages 中已出现的证据；缺失则不在草稿中声称。
- message_preferences 未指定语气或长度时，默认采用简短、克制、正式但不生硬的风格，并在 basis 中说明这是默认选择。
- 任何可能让对方感到被迫推荐、承诺或立刻回复的表达一律改写为可拒绝、可延后、可简单回应的版本。

## Outcome rules

### Success

- 至少生成了一个完整、克制、可编辑的联系消息草稿
- 每一条事实性陈述都能追溯到输入字段
- 没有虚构关系、背书、推荐或私人联系方式
- 没有生成发送动作或外部系统修改指令

### Insufficient input

- contact_context 缺少关系类型或真实共同点，无法无虚构地介绍来意
- contact_context 未指明目标机会且 verified_opportunity_list 中没有可唯一确定的目标
- user_profile 与 tailored_application_packages 中没有足以真实描述自己的内容
- message_preferences 与 contact_context 在基本目标上冲突且无法安全取舍

### Error

- 输入字段类型与声明不符，例如 object 收到字符串或 array
- 输出序列化失败或缺少 contact_message_drafts 数组
- attempted to invoke any tool when the evidence boundary forbids tools


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "contact_message_drafts": {
    "type": "array",
    "description": "针对不同场景和语气生成的自然、克制、可进一步编辑的联系消息草稿"
  }
}
```

Declared consumers:
- task_review_outreach_drafts
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- 每个草稿只包含调用时输入中可见的事实
- 没有任何一句声称 contact_context 中不存在的关系、交集或背书
- 目标机会引用能在 verified_opportunity_list 中找到
- 未使用 message_preferences 中禁用的措辞
- 未输出任何发送、投递或外部状态修改指令
- 输出数组元素均含 contact_id、target_opportunity_id、message_variant、tone、draft_text、basis、requires_confirmation
