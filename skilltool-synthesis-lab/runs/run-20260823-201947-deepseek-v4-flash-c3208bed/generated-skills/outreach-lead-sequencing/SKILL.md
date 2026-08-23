---
name: outreach-lead-sequencing
description: "当用户已经获得公开入口线索清单和熟人线索清单，需要决定接下来先联系谁、后联系谁时使用。不适用于尚未产出线索清单、需要寻找新线索、核验线索真实性或编写联系消息的情景。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 外联对象联系顺序规划

联系人顺序规划者：把两个上游线索清单中的线索，在用户联系边界和机会优先顺序约束下排成一个可执行的联系顺序。

## Goal

把已存在的公开入口线索和熟人线索，结合机会优先顺序与用户联系边界，排成一个可执行的联系先后计划，每条线索包含先后位置、接触方式、建议时间和理由。

## Hard boundary

- 只消费本调用提供的 referral_entry_lead_list、matched_network_lead_list、opportunity_pursuit_ranking、user_contact_rules 和 user_time_budget，不得检索外部信息或读取其他文件
- 不得实际发送、投递、撤回或修改任何外部系统状态
- 不得虚构共同经历、熟人背书、验证状态或联系信息
- 不得重新生成机会优先级、用户画像或投递材料
- 不得把被用户排除的渠道或人物安排为可行动条目

In scope:

- 合并并去重公开入口线索与熟人线索
- 按机会优先顺序排序线索
- 应用用户联系边界过滤并分批排期
- 为每条线索输出先后位置、接触方式、建议时间和理由

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `referral_entry_lead_list` (array, required; source `prior_skill_output`, asset `referral_entry_lead_list`, acquisition `prior_skill`): 用户已有产物，是按机会整理的公开入口、渠道和联系人线索清单
- `matched_network_lead_list` (array, required; source `prior_skill_output`, asset `matched_network_lead_list`, acquisition `prior_skill`): 用户已有产物，是从现有联系人中筛出的可接触内推线索清单
- `opportunity_pursuit_ranking` (array, required; source `upstream_artifact`, asset `opportunity_pursuit_ranking`, acquisition `provided`): 场景已有产物，是用户已确认的机会投递优先顺序，用于决定先围绕哪个机会接触人
- `user_contact_rules` (object, required; source `user_input`, acquisition `request_user`): 用户对接触方式的限制、不想打扰的人、渠道排除项和频率上限
- `user_time_budget` (object, required; source `user_input`, acquisition `request_user`): 用户最近一段可投入的总时间和希望分批接触的节奏

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 校验并冻结输入

- 确认 referral_entry_lead_list、matched_network_lead_list、opportunity_pursuit_ranking、user_contact_rules 和 user_time_budget 均已提供且结构可解析
- 以本调用收到的输入为准，不补充外部搜索、不读取额外上下文
- 若任一必需输入缺失或两个线索清单均为空数组，直接进入 insufficient_input

Success criteria:

- 五个输入全部存在且可解析
- 至少一个输入线索清单包含可识别的 lead_id 或 contact_id

### 2. 合并并去重线索

- 把 referral_entry_lead_list 与 matched_network_lead_list 按 lead_id 或 contact_id 合并
- 同一线索同时出现时保留证据更完整的一条，并在 reason 中保留两个来源标识
- 为每条线索记录来源清单、关联机会标识和可用接触渠道

Success criteria:

- 每个 lead 在输出中只出现一次
- 每条线索可从至少一个上游清单追溯到来源

### 3. 应用用户联系边界

- 逐条比对 user_contact_rules 中的排除渠道、不想打扰的人和频率上限
- 违反规则的线索标记为 status=excluded，sequence_rank 置空，reason 写明排除依据
- 不违反规则的线索保留为待排序，status 初始化为 pending

Success criteria:

- 被排除线索与可行动线索清楚分离
- 排除理由均来自 user_contact_rules

### 4. 计算机会优先级并排序

- 把每条待排序线索关联到 opportunity_pursuit_ranking 中的机会位置
- 按机会优先级从高到低排序；无法关联到排序表的机会排在已关联机会之后
- 同机会下按验证状态优先、可核验公开来源优先、接触渠道明确优先的次序打破并列

Success criteria:

- 每条可行动线索获得唯一正整数 sequence_rank
- 排序顺序可由机会优先级和并列规则解释

### 5. 分配联系时间并组装结果

- 根据 user_time_budget 的总时间和分批节奏，为每条可行动线索分配 suggested_time
- 超出时间预算或批次容量的线索标记为 status=pending_next_batch，保留 rank 但不再分配时间
- 按 sequence_rank 升序输出 outreach_sequence_plan，每个条目包含 lead_id、sequence_rank、contact_channel、suggested_time、reason、status

Success criteria:

- 所有可行动条目均含非空 reason 和正数 rank
- suggested_time 不超出用户时间预算的总量设定

## Decision rules

- 约束优先：user_contact_rules 中的排除项优先于任何排序规则；违反者只能处于 excluded 状态
- 主排序键为关联机会在 opportunity_pursuit_ranking 中的位置，位置越靠前越先联系
- 无法关联到机会排序表的线索排在已关联线索之后，并在 reason 中说明该机会未在排序表中出现
- 同机会内并列时按验证状态优先、公开来源明确优先、接触渠道明确优先的顺序打破并列
- 时间预算分批：若全部线索超出 user_time_budget，则先安排第一批，其余标记为 pending_next_batch

## Outcome rules

### Success

- 至少存在一条可行动线索
- 输出数组按 sequence_rank 升序且每条可行动线索包含 lead_id、接触渠道、建议时间和理由
- 没有对外执行任何发送或修改动作

### Insufficient input

- referral_entry_lead_list 缺失或为空且 matched_network_lead_list 缺失或为空
- opportunity_pursuit_ranking 缺失或不可解析
- user_time_budget 缺失或不可解析
- 无法从任何输入中解析出 lead_id 或 contact_id

### Error

- 输入结构无法解析导致无法生成数组
- 同一线索被多个输入重复且证据来源相互冲突到无法消解
- 输出序列化失败


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "outreach_sequence_plan": {
    "type": "array",
    "description": "按机会价值和用户约束排出的线索联系顺序，含每条线索的先后位置、接触方式、建议时间和理由"
  }
}
```

Declared consumers:
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- 每个输出条目的 lead_id 都能在 referral_entry_lead_list 或 matched_network_lead_list 中追溯
- 每条可行动线索都有非空 reason 和正数 sequence_rank
- 任何被 user_contact_rules 排除的渠道或人物没有被分配正数 sequence_rank
- suggested_time 总量不超过 user_time_budget 的可用设定
- 输出中没有新增联系信息、验证状态、共同经历或机会事实
- 调用 ReturnSkillResult 恰好一次
