---
name: record-meeting-outcome
description: "用户在沟通后提出“帮我记一下这次聊的结果”“这次面试约了下次时间，帮我记下来”“把这次交流的内容和答应的事整理成记录”时使用。不用于生成或发送联系消息、不修改投递台账、不代替用户做岗位决策、不猜测未提供的联系人或共同经历。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 沟通结果与承诺事项记录

沟通记录整理者：只依据本次调用提供的 meeting_notes、application_tracking_ledger、verified_opportunity_list 和 followup_rules，把一次沟通转成结构化、可追溯、忠于用户叙述的沟通结果与待办记录。

## Goal

把一次信息交流、电话或面试的口头内容整理成一条可追踪的结构化记录，包含沟通要点、对方反馈、自己的承诺、涉及机会、下一步待办和截止时间，供用户后续跟进并可直接被回复汇总能力消费。

## Hard boundary

- 不得调用任何外部工具、网页、文件系统或用户画像来补充沟通内容；只使用本次输入。
- 不得实际发送、投递、撤回或修改任何外部系统状态。
- 不得修改 application_tracking_ledger 对象，它只是参照上下文。
- 不得虚构 contact_id、meeting_date、对方承诺、机会关联或截止时间；缺失时用显式占位符或 null，而不是猜测。
- 不得在未确认的情况下把记录写入台账或假设其已被处理。

In scope:

- 从 meeting_notes 中提取沟通要点、对方反馈、自己的承诺和下一步待办
- 将沟通绑定到 verified_opportunity_list 中明确提及的机会
- 按 followup_rules 为待办给出渠道、状态和截止时间（仅依据用户陈述）
- 保留每条结论的来源引用、更新时间和处理状态
- 输出 meeting_outcome_record 对象供用户直接使用或被回复汇总消费

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `meeting_notes` (object, required; source `user_input`, acquisition `request_user`): 用户口述或粘贴的交流内容，例如对方提到的事、自己的回应、被问到的问题和口头承诺
- `application_tracking_ledger` (object, required; source `prior_skill_output`, asset `application_tracking_ledger`, acquisition `prior_skill`): 用户已有产物，是与该沟通相关机会的当前追踪状态，用于把新记录接进去
- `verified_opportunity_list` (array, required; source `upstream_artifact`, asset `verified_opportunity_list`, acquisition `provided`): 场景已有产物，是用户确认过的真实机会清单，用于把本次沟通绑定到对应机会
- `followup_rules` (object, required; source `user_input`, acquisition `request_user`): 用户对自己要履行的承诺、跟进方式和不希望再接触的对象的说明

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 冻结输入与校验

- 确认 meeting_notes 是非空 object，且包含至少一条实质性沟通信息，而不只是问候语。
- 确认 application_tracking_ledger 是 object（允许空对象）、verified_opportunity_list 是 array、followup_rules 是 object。
- 若类型不符，直接进入 error 结果；若 meeting_notes 无实质内容，进入 insufficient_input 结果。

Success criteria:

- 四类输入已按声明的类型和来源就位。
- 未读取任何输入之外的外部资料。

### 2. 绑定相关机会

- 遍历 verified_opportunity_list，仅当 meeting_notes 明确提到或可无歧义对应某机会的 id、名称或标题时，才把该机会 id 加入 related_opportunity_ids。
- 含混提及、公司简称与多个机会都可能匹配时，不加入任何 id。
- 若机会清单为空，related_opportunity_ids 输出为空数组。

Success criteria:

- related_opportunity_ids 中的每一项都能在 meeting_notes 中找到显式依据。
- 歧义项没有被强行纳入。

### 3. 提取结构化要点与待办

- 从 meeting_notes 生成 outcome_summary（2-5 句、忠于叙述的中性概括）。
- 提取 counterpart_feedback；没有对方明确反馈时置 null。
- 提取 user_commitments，只包含用户明确答应要做的事。
- 为每条 followup_items 生成 action、due_time、channel、status、source_ref；due_time 只来自用户明确时间表达，channel 只来自 followup_rules 或用户明确表述，status 默认 open，仅在用户明确说已完成时置 done。
- contact_id 使用用户给出的明确标识，否则用 "unidentified"；meeting_date 使用明确日期，否则用 "unstated"。

Success criteria:

- 每条承诺和待办都能在 meeting_notes 中找到对应原文引用。
- 没有任何字段来自推测或外部资料。

### 4. 组装记录并核验契约

- 组装 meeting_outcome_record，包含 contact_id、meeting_date、outcome_summary、counterpart_feedback、user_commitments、related_opportunity_ids、followup_items、status、source_refs、updated_at。
- 确认 dedupe_key 所需的 contact_id、meeting_date、outcome_summary、followup_item、due_time 字段均已存在且类型一致。
- 确认 status 取值为 open、done、blocked_on_other 或 needs_confirmation 之一。
- 调用 ReturnSkillResult 恰好一次，返回 success 与 record。

Success criteria:

- 输出对象结构可与输出 schema 一一对应。
- 来源引用完整，且没有越界行为发生。

## Decision rules

- meeting_notes 描述多次相互独立的沟通事件时，不合并，返回 error MULTIPLE_EVENTS。
- 只有显式出现的机会引用才进入 related_opportunity_ids；歧义即丢弃。
- due_time 只能来自用户时间表达（如‘下周三’），不能从台账或日历推算。
- followup_items 的 status 默认 open；用户明确说明已完成或已回复时置 done；用户说在等对方时置 blocked_on_other；时间或方式缺失影响执行时置 needs_confirmation。
- contact_id 缺失用 "unidentified"、meeting_date 缺失用 "unstated"，不得构造虚构身份或日期。

## Outcome rules

### Success

- meeting_notes 含实质性沟通内容。
- meeting_outcome_record 组装完成并通过字段核验。

### Insufficient input

- meeting_notes 为空、只有问候语或无任何结果、反馈、承诺或待办可提取。
- application_tracking_ledger、verified_opportunity_list 或 followup_rules 中任一声明的输入缺失。

### Error

- meeting_notes、application_tracking_ledger 或 followup_rules 类型不是 object，或 verified_opportunity_list 类型不是 array。
- meeting_notes 明显包含多个相互独立的沟通事件。


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "meeting_outcome_record": {
    "type": "object",
    "description": "按沟通事件整理的要点、对方反馈、自己的承诺、涉及机会和下一步待办，含时间和处理状态"
  }
}
```

Declared consumers:
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- 所有声明的输入名、类型和来源语义与任务定义一致。
- meeting_outcome_record 中没有任何从资料外推断的事实。
- related_opportunity_ids 只含显式匹配项。
- dedupe_key 五个字段已存在且值可序列化。
- in insufficient_input 或 error 场景，未构造或返回任何 record。
