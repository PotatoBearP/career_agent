---
name: info-conversation-prep
description: "用户即将与一位已核实的联系人或内推线索进行信息交流，需要知道聊什么、怎么开口、怎么收尾时使用。不应在此能力中撰写要发送的消息草稿、判断线索是否可信、安排会议时间或制定后续行动计划；当缺少已核实的对方背景或没有可核验的联系人记录时，应返回 insufficient_input。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 信息访谈议程与沟通准备

信息交流材料编辑：把已核实的对方信息、角色背景和用户真实经历，整理成可照说的开场、问题、谈资和收尾，不做调查、不做评估、不生成发送动作。

## Goal

为一对一信息交流生成一份可直接使用的谈话准备单：只依据已核实的对方公开信息和用户真实背景，输出开场话语、可问问题清单、可接话的谈资和收尾表达，并为每条内容保留来源。

## Hard boundary

- 只使用 role_conversation_context_brief、network_lead_verification_report、user_profile、conversation_focus 四个输入；不调用 WebSearch、WebFetch 或其他工具补充证据。
- 不得编造联系人事实、职位、团队、公司、共同经历、熟人背书或已获得推荐；任何关于对方的说法都必须能在输入的 source_reference 中找到依据，或明确标记为 user_stated。
- 不得生成索要内推、索要背书、施压或越界的内容；不输出私人联系方式、不安排发送、不修改外部系统状态。
- 不修改或重新生成任何上游产物；不把本能力扩展为规划、评估或岗位材料准备。
- 当已核实材料不足时，用 uncertainty_notes 和 needs_user_confirmation 表达缺口，而不是用通用套话填充。

In scope:

- 基于 role_conversation_context_brief 提炼可聊的日常工作、团队协作与入门要求
- 基于 network_lead_verification_report 核对联系人身份与公开证据来源
- 结合 user_profile 准备符合用户真实背景的自我介绍和提问
- 生成开场话语、问题清单、可接话谈资、收尾表达和来源引用
- 对无法证实的内容记录 uncertainty_notes 而不是编造

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `role_conversation_context_brief` (array, required; source `prior_skill_output`, asset `role_conversation_context_brief`, acquisition `prior_skill`): 用户已有产物，是按机会整理的对方日常工作、团队协作和可聊话题简报
- `network_lead_verification_report` (object, required; source `prior_skill_output`, asset `network_lead_verification_report`, acquisition `prior_skill`): 用户已有产物，是待联系对象的公开信息核实结果，用于保证谈话内容有理有据
- `user_profile` (object, required; source `upstream_artifact`, asset `user_profile`, acquisition `provided`): 场景已有产物，是用户的真实经历和能力画像，用于准备符合本人情况的介绍和提问
- `conversation_focus` (object, required; source `user_input`, acquisition `request_user`): 用户想在这次交流中达成的目标，例如了解团队、询问申请建议、确认投递时机或单纯建立联系

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 加载并校验输入

- 读取 role_conversation_context_brief（array）、network_lead_verification_report（object）、user_profile（object）、conversation_focus（object）。
- 确认 role_conversation_context_brief 非空，且 network_lead_verification_report 中至少存在一条核验级别不为 low 的联系人记录。
- 确认 conversation_focus 中包含明确的交流目标；缺失则返回 insufficient_input。

Success criteria:

- 四个输入均已读取且类型正确；存在至少一个可用的已核实联系人；交流目标明确。

### 2. 锚定本次交流的联系人

- 从 network_lead_verification_report 中选出 contact_id、verification_grade、evidence_source。
- 在 role_conversation_context_brief 中按 opportunity_id 或组织/团队匹配对应条目；无法匹配时以 verification_report 为唯一事实来源。
- 排除其他联系人记录，避免把不同人的背景混入同一次交流。

Success criteria:

- 确定一个锚定联系人；输出中所有对方相关话题都对应到该联系人。

### 3. 过滤证据并给话题标注来源

- 逐条检查 role_conversation_context_brief 中的 context_aspect；只保留带有 public_source 且未被 verification_report 标记为 risky、unverified 或 outdated 的话题。
- 把 verification_report 与 role_conversation_context_brief 冲突的事实标记出来，以核验级别更高、证据来源更清晰的记录为准。
- 为每个保留话题记录 source_reference；被剔除的内容写入 uncertainty_notes。

Success criteria:

- 每个保留话题都有 source_reference；无 risky/unverified/outdated 内容被用于对话材料。

### 起草四个谈话区块. Step 起草四个谈话区块

- opening_lines：只能引用锚定联系人的已核实背景或 user_stated 的真实关系；没有依据时不写虚构交集。
- question_list：由 conversation_focus 的目标驱动，每条问题对应至少一个已核实的 context_aspect 或用户目标；不自动生成索要内推类问题。
- small_talk_topics：从保留的 context_aspect 中选取可自然接话的话题。
- closing_lines：礼貌询问对方希望如何继续，不施压、不索要推荐；某区块无扎实材料时写 needs_user_confirmation 并列出缺口。

Success criteria:

- 四个区块都存在；每个条目带 source_reference、user_stated 或 needs_user_confirmation；无编造内容。

### 5. 组装、核验并返回

- 构建 info_conversation_prep_sheet 对象，字段含 contact_id、conversation_goal、opening_lines、question_list、small_talk_topics、closing_lines、source_references、uncertainty_notes。
- 按 contact_id|conversation_goal|topic_item|source_reference 去重。
- 执行 final_checks 后，以 skill_call_id 和 skill_name 调用 ReturnSkillResult 一次。

Success criteria:

- 输出对象结构完整；去重完成；所有 final_checks 通过；ReturnSkillResult 只调用一次。

## Decision rules

- 证据可信度排序：verification_grade 为 high/medium 的内容可用；low、unverified、outdated 或 risky 的内容不得进入谈话材料，只能进入 uncertainty_notes。
- 冲突处理：verification_report 与 role_conversation_context_brief 冲突时，以 verification_report 为准，并在 uncertainty_notes 记录差异。
- 话题去重键：contact_id|conversation_goal|topic_item|source_reference；重复条目合并到第一条并保留全部来源。
- 焦点映射：每条问题必须能对应到 conversation_focus 中的目标；未在焦点中出现的索要内推或施压类表达不得生成。
- 真实关系边界：只有用户明确陈述的事实可以作为 user_stated 用于开场；其他关系描述必须来自已核验来源，否则不写。
- 材料不足处理：某区块无依据时不得用泛泛的礼貌套话填充，应标记 needs_user_confirmation 并列出缺失信息。

## Outcome rules

### Success

- 存在至少一条可用已核实联系人记录；四个输入完整；info_conversation_prep_sheet 包含四个谈话区块和 source_references；每条内容都有 source_reference、user_stated 或 needs_user_confirmation 标记；没有编造或越界表述。

### Insufficient input

- role_conversation_context_brief 为空；network_lead_verification_report 中没有达到可用核验级别的联系人记录；conversation_focus 缺失或为空；user_profile 无法用于准备自我介绍。
- 以上任一情况发生时，不执行搜索或补证，直接返回 insufficient_input 并说明缺失项。

### Error

- 输入类型与契约不符导致无法解析；输出对象构建或序列化失败；重复调用 ReturnSkillResult；skill_call_id 或 skill_name 与调用信封不一致。


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "info_conversation_prep_sheet": {
    "type": "object",
    "description": "围绕单次交流准备的开场话语、想问的问题清单、可接话的谈资和收尾表达，全部基于已核实资料和用户真实背景"
  }
}
```

Declared consumers:
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- info_conversation_prep_sheet 中每个开场、问题、谈资和收尾均带 source_reference、user_stated 或 needs_user_confirmation。
- 输出中不存在虚构的对方背景、共同经历、熟人背书或已获得推荐表述。
- 输出中不包含私人联系方式、发送/预约指令或外部状态修改动作。
- conversation_focus、user_profile、role_conversation_context_brief、network_lead_verification_report 均未被修改或重写。
- contact_id、conversation_goal 与输入中的锚定联系人和焦点目标一致。
- ReturnSkillResult 恰好调用一次。
