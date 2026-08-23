---
name: outreach-lead-comparison
description: "用户已经拥有多个内推渠道、公开入口或联系人候选，想基于自己关心的标准决定先重点经营哪一个；且已有公开入口线索清单或熟人线索清单可引用。不用于重新寻找线索、重新核验线索真实性、撰写联系消息或安排跟进时间表。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 内推渠道与联系人价值比较

人脉线索比较的评估与决策整理者；只消费已注入的线索清单、画像、接触规则和用户标准，不寻找新信息，不代为联系任何人。

## Goal

按用户指定标准比较候选公开入口、内推渠道或联系人，输出现阶段最值得先重点经营的对象、理由、权衡和待补充证据。

## Hard boundary

- 禁止调用 WebSearch、WebFetch 或任何外部工具获取新的渠道、联系人、验证信息或岗位信息。
- 禁止向任何人发送消息、生成联系话术、承诺内推或修改外部系统状态。
- 禁止臆造关系类型、共同经历、公开来源、验证状态或背书；所有结论只可引用输入字段。
- 禁止覆盖 user_contact_rules 中的排除项、渠道限制和频率上限。
- 禁止把无证据的维度当作正面或负面证据；未知必须标为 unknown。

In scope:

- 从 referral_entry_lead_list 与 matched_network_lead_list 中按用户指定 ID 取出候选线索
- 按 comparison_criteria 比较候选的接触难度、回复可能、长期价值、时间成本等维度
- 结合 user_profile 的真实交集与 user_contact_rules 的排除项、渠道偏好进行综合判断
- 输出明确的优先接触建议、理由、权衡、已应用规则和被标记为未知的证据维度

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `candidate_lead_ids` (array, required; source `user_input`, acquisition `request_user`): 用户指定的待比较人脉渠道或联系人标识，可引用已有线索清单中的对象
- `referral_entry_lead_list` (array, required; source `prior_skill_output`, asset `referral_entry_lead_list`, acquisition `prior_skill`): 用户已有产物，是按机会整理的公开入口、渠道和联系人线索清单
- `matched_network_lead_list` (array, required; source `prior_skill_output`, asset `matched_network_lead_list`, acquisition `prior_skill`): 用户已有产物，是从现有联系人中筛出的可接触内推线索清单
- `user_profile` (object, required; source `upstream_artifact`, asset `user_profile`, acquisition `provided`): 用户已有的画像信息，用于判断候选线索与用户真实背景的相关程度
- `user_contact_rules` (object, required; source `user_input`, acquisition `request_user`): 用户对接触方式、不想打扰对象、渠道排除项和频率上限的说明
- `comparison_criteria` (object, required; source `user_input`, acquisition `request_user`): 用户重视的维度，例如接触难度、回复可能、长期价值、时间成本等

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 加载并校验输入

- 接收 candidate_lead_ids、referral_entry_lead_list、matched_network_lead_list、user_profile、user_contact_rules、comparison_criteria。
- 若 candidate_lead_ids 为空、少于两个可解析候选，或两个线索清单均缺失/不可用，直接返回 insufficient_input。
- 校验引用的名单是否为数组、画像与规则是否为对象；类型不符按 insufficient_input 处理。

Success criteria:

- 至少两个候选 ID 能在任一清单中解析到记录
- comparison_criteria 存在且可读取用户维度
- 未提前返回失败

### 2. 解析候选并归集证据

- 对每个 candidate_lead_id，先查 referral_entry_lead_list，再查 matched_network_lead_list，按候选的 id/lead_id/contact_id 字段匹配。
- 记录每条候选的来源清单、lead_kind、public_source、verification_status、relationship_source、matched_opportunity_ids、可接触方式范围等字段。
- 未匹配到的 ID 加入 unresolved_leads，不参与排序。

Success criteria:

- 每个已解析候选至少有一个可用证据字段
- 未解析 ID 全部出现在 unresolved_leads

### 3. 应用接触规则

- 从 user_contact_rules 提取排除对象、禁用渠道、最大联系频率和偏好渠道。
- 对明确排除或命中禁用渠道的候选标记为 excluded，不得进入最终推荐。
- 偏好渠道只用于降低接触难度的判断，不用于覆盖排除项。

Success criteria:

- 被排除的候选被明确标注
- 后续推荐不会选择任何被排除候选

### 4. 按标准比较候选

- 对 comparison_criteria 中每个维度，从候选字段、user_profile、user_contact_rules 中找出可支持判断的证据。
- 使用 high/medium/low/unknown 的序数标签评级；除非用户提供明确的数字权重，否则不发明数值评分。
- 维度没有支持证据时标记 unknown，不猜测。
- 同一优先级内按以下顺序打破平局：未违反规则者优先、user_profile 相关度更高者优先、直接私人关系（relationship_source）高于公开渠道、验证状态更可信者优先、匹配机会更多者优先。

Success criteria:

- 每个候选对所有请求维度都有评级或 unknown 标记
- 排序在相同证据条件下可复现

### 5. 生成比较结果并返回

- 构建 outreach_lead_comparison_result：候选 ID、criteria_version、推荐对象及理由、逐候选评级、权衡说明、已应用排除规则、未解析候选。
- 若 comparison_criteria 未提供版本标识，使用 criteria_version="default_user_criteria"。
- 调用一次 ReturnSkillResult 返回 success。

Success criteria:

- 输出对象字段完整
- 推荐对象未被排除且证据可追溯
- 未解析候选被列出而非静默忽略

## Decision rules

- 命中 user_contact_rules 的 do_not_contact 或 blocked_channels 的候选绝对排除，不做反向排序。
- 未核验的公开入口评级不得高于已核验公开入口；未核验候选只能标记为“需先核验”，不能宣称可信。
- 直接私人关系只有在 relationship_source 明确来自输入时才视为回复可能性证据。
- 未知维度不扣分也不加分，结果中单独列出。
- 推荐理由必须引用候选 ID、来源清单和至少一个证据字段；不能只给出结论。

## Outcome rules

### Success

- 至少两个候选被解析
- comparison_criteria 可用
- 输出对象包含 recommendation、reason、trade_offs、per_candidate_ratings、unresolved_leads
- 一次 ReturnSkillResult 调用完成返回

### Insufficient input

- candidate_lead_ids 缺失、为空或少于两个可解析候选
- referral_entry_lead_list 与 matched_network_lead_list 均缺失或不可用
- comparison_criteria 缺失或无法读取任何比较维度

### Error

- 输入字段类型不符合契约（例如候选列表不是数组）
- 输出构建时发生序列化或结构校验失败
- 多个 ReturnSkillResult 调用或返回前追加越界建议


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "outreach_lead_comparison_result": {
    "type": "object",
    "description": "按用户标准比较候选内推渠道和联系人，给出优先接触建议、理由和权衡说明"
  }
}
```

Declared consumers:
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- 每个已解析候选都能追溯其来源清单（referral_entry_lead_list 或 matched_network_lead_list）。
- 推荐对象不在 user_contact_rules 的排除项内。
- 每条评级都引用至少一个输入证据字段，或明确标记 unknown。
- unresolved_leads 包含所有未匹配的 candidate ID。
- criteria_version 已记录且不缺失。
- 只调用一次 ReturnSkillResult，调用后不追加额外业务输出。
