---
name: draft-informational-interview-outreach
description: "当用户已经准备好信息访谈材料，要求把访谈目标改写为联系从业者的开场消息、私信或约聊话术时使用。不用于生成简历、求职信、推荐请求、访谈问题清单或完整谈话脚本；不重新生成访谈准备材料；不代替用户发送消息、安排时间或模拟对方回复。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 帮我写联系从业者约聊的开口消息

备稿者：把信息访谈准备材料转化为一组可由用户审阅后发送的约聊开口消息草稿，不替用户决定联系谁，也不替用户发送消息。

## Goal

在既有信息访谈准备材料基础上，结合联系场合与用户画像，产出多版礼貌、具体、可发送的约聊开口消息草稿，并逐版标注适用场合、语气特点、希望对方回应的点和注意事项。

## Hard boundary

- 只使用 skill-action 输入提供的 interview_prep_kit、outreach_context、user_profile 三个来源；不调用 WebSearch、WebFetch、Read、Bash 等工具，不回读其他文件、画像目录或历史上下文。
- 不虚构对方姓名、公司、职位、共同联系人、活动经历、历史互动或任何未经用户确认的信息；凡输入中不存在的细节一律省略或标记为“需用户确认”。
- 不生成简历文案、求职信、推荐请求、访谈问题清单或完整谈话脚本；访谈内容必须来自 interview_prep_kit。
- 不代替用户发送消息、承诺交流时间或生成对方回复；不得使用“你上次说……”“我们之前聊过”等无证据表述。
- 只调用 ReturnSkillResult 一次；调用前不向用户追加使用建议或额外指导。

In scope:

- 从 interview_prep_kit 中提炼约聊目的、拟探讨主题和希望了解的问题点
- 根据 outreach_context 确定联系平台、场合、与对方关系和希望的语气
- 基于 user_profile 中可核验的事实撰写简短真实的自我介绍
- 产出多版约聊消息草稿，每版标注适用场合、语气特点、希望对方回应的点、注意事项
- 设计低门槛、可拒绝的请求方式，尊重对方时间

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `interview_prep_kit` (object, required; source `prior_skill_output`, asset `interview_prep_kit`, acquisition `prior_skill`): 已生成的信息访谈目标与提问重点，作为消息内容的基础
- `outreach_context` (object, required; source `user_input`, acquisition `request_user`): 联系场合、平台类型、与对方的关系以及希望的语气
- `user_profile` (object, required; source `upstream_artifact`, asset `user_profile`, acquisition `provided`): 用户画像中的已有背景与约束，用于写出真实可信的自我介绍

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 冻结输入并提取四要素

- 从 interview_prep_kit 提取访谈目标、拟探讨主题和待验证疑点。
- 从 outreach_context 提取联系平台、正常场合、与对方关系、希望语气。
- 从 user_profile 提取可核验的自我介绍事实。
- 分别列出“对方是谁/为什么找对方/想了解什么/我为什么值得回复”四项，缺失项单独记录。
- 不引入输入之外的任何个人信息。

Success criteria:

- 四要素清单已列出且每项都能追溯到输入字段
- 缺失要素已被明确标记

### 2. 确定消息版本矩阵

- 根据 outreach_context 确定 2-3 个版本；多平台或多关系时按场景拆分，单一平台至少保留一版正式一版简短。
- 为每版确定适用场合、语气标签、称呼方式、目标长度和最希望对方回应的点。
- 每版控制在普通陌生人两分钟内能读完的篇幅。

Success criteria:

- 每版都有适用场合、语气、期望回应点
- 版本间差异可解释且不出现求职信语气

### 3. 起草每条消息

- 按“简短自我介绍→联系理由→一个具体低门槛请求→礼貌退出”的结构起草。
- 自我介绍只使用 user_profile 中的已声明事实。
- 联系理由只使用 interview_prep_kit 的访谈目标以及 outreach_context 中用户提供的对方可见信息。
- 请求设计为可拒绝、低时间成本的形式，如 20-30 分钟语音或文字交流；只根据 outreach_context 判断是否可建议更长形式。
- 不写“我十分适合”“我觉得您”等无证据断言，不把访谈目标改成求职推销。

Success criteria:

- 每条消息包含自我介绍、理由、具体请求、退出语
- 可被不认识用户的人独立理解
- 请求可被低门槛接受

### 4. 校验并标注每版草稿

- 确认每版都标记了适用场合、语气特点、希望对方回应的点、注意事项。
- 检查所有个人背景可追溯到 user_profile，所有对方信息可追溯到 outreach_context 或已标记“需用户确认”。
- 若 outreach_context 未提供对方姓名、公司或具体联系理由，在注意事项中提示用户发送前补充。
- 若 interview_prep_kit 缺失访谈目标或可转化的问题点，不靠猜测补全，直接进入 insufficient_input。

Success criteria:

- 每版都有四项标注
- 不存在未标注的推测事实
- 不存在与输入冲突的表述

### 5. 组装并返回结果

- 将每版草稿组装为 outreach_message_drafts 数组，每个元素包含 draft_text、适用场合、语气特点、希望对方回应的点、注意事项。
- 确认全部内容组装完成后再调用 ReturnSkillResult 一次。
- 成功时返回数组；输入不足时返回 insufficient_input 说明缺失项，不返回半成品。

Success criteria:

- 数组完整且字段齐全
- 已恰好调用一次 ReturnSkillResult
- 调用后未再追加任何内容

## Decision rules

- 版本数量：默认 2-3 版；outreach_context 指明多个平台或多种关系时按场景拆分；只有单一平台时至少保留一版较正式和一版更简短，避免单版不可用。
- 语气映射：职场或招聘类平台默认“礼貌正式但简洁”；私信、社群或邮件默认“平实具体”；用户明确要求“不要太正式”时使用口语化但保持尊重。
- 请求门槛：优先设计可拒绝、低时间成本的请求；只有 outreach_context 明确允许时才建议更长的交流形式。
- 证据归属：自我介绍只使用 user_profile 中已声明事实；对方信息只使用 outreach_context 中用户提供的内容；两者之外的细节必须省略或标记“需用户确认”。
- 冲突处理：interview_prep_kit 与 outreach_context 的语气或目标冲突时，以 outreach_context 的场合为准，并在注意事项中说明该冲突。

## Outcome rules

### Success

- interview_prep_kit 包含访谈目标且至少有一个可转化为消息的问题点
- outreach_context 提供了平台或场合、与对方关系、语气意愿
- user_profile 中至少存在一项可用于自我介绍的可核验事实
- 输出了至少 2 版带四项标注的约聊消息草稿

### Insufficient input

- interview_prep_kit 缺失或缺少可用的访谈目标与问题点
- outreach_context 缺失平台/场合/关系/语气，且用户拒绝补充
- user_profile 中没有任何可核验的自我介绍事实
- 此时返回 insufficient_input 并列出缺失项，不猜测补全

### Error

- 输入结构与声明类型不符，如 interview_prep_kit 不是 object
- 结果无法序列化为 outreach_message_drafts 数组
- 返回 error 并说明原因，不输出半成品


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "outreach_message_drafts": {
    "type": "array",
    "description": "多版联系消息草稿，每版说明适用场合、语气特点、希望对方回应的点和注意事项"
  }
}
```

Declared consumers:
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- outreach_message_drafts 是 array 且至少 2 版，每版都包含 draft_text、适用场合、语气特点、希望对方回应的点、注意事项。
- 每条消息中的所有个人背景都可追溯到 user_profile，所有对方信息都可追溯到 outreach_context 或已标记“需用户确认”。
- 未调用 WebSearch、WebFetch、Read、Bash 等工具，未生成简历、求职信、推荐请求或访谈问题清单。
- 未虚构任何对方姓名、公司、职位、共同经历或历史关系。
- 已只调用一次 ReturnSkillResult，且发生在全部内容组装完成后。
