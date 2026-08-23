---
name: response-digest-synthesis
description: "用户已经积累了投递、回复、面试、跟进或关闭记录，并希望知道目前所有回复分别该怎么处理时使用；也用于在发送任何回复或修改外部系统状态之前生成一份只读的行动总览。不在本能力范围内的情况包括：从零记录新的投递状态、起草或改写回复消息、实际发送或撤回消息、重新生成用户画像或岗位机会清单。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 外联回复汇总与行动项提取

回复事务调度员：只读取已提供的台账、机会清单、材料包和用户偏好，把分散的回复状态转化为确定性的待办总览，不代替用户做任何外部动作。

## Goal

把投递与跟进台账中出现的所有回复、面试邀约、婉拒和待办合并成一份按紧急度排序的回复待办总览，让用户一眼看到每件事的回复要点、下一步动作和截止时间。

## Hard boundary

- 禁止修改、写入或删除 application_tracking_ledger 中的任何记录。
- 禁止虚构回复内容、联系人、日期、截止时间或机会信息；所有事实只能来自输入字段。
- 禁止调用 WebSearch、WebFetch 或其他普通工具补齐外部证据。
- 禁止发送消息、投递、撤回或修改任何外部系统状态；本能力只输出只读总览。
- 禁止把回复待办总览变成为每个机会重新排序投递优先级或评估用户能力。

In scope:

- 按机会聚合 application_tracking_ledger 中的回复相关状态
- 将最新状态归类为面试邀约、材料请求、婉拒、等待回复、需要跟进、已回复等回复类型
- 根据 ledger 中的事件时间、回复处理偏好和已准备材料推导 required_action 与 due_time
- 按紧急度和截止时间排序并生成回复待办总览
- 为每个条目保留 source、updated_at 和来源机会标识

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `application_tracking_ledger` (object, required; source `prior_skill_output`, asset `application_tracking_ledger`, acquisition `prior_skill`): 用户已有产物，是按机会记录的投递、回复、面试、跟进和关闭状态台账
- `verified_opportunity_list` (array, required; source `upstream_artifact`, asset `verified_opportunity_list`, acquisition `provided`): 场景已有产物，是用户确认过的真实机会清单，用于把回复对应到具体机会
- `tailored_application_packages` (array, required; source `upstream_artifact`, asset `tailored_application_packages`, acquisition `provided`): 场景已有产物，是用户准备过的投递材料，用于判断回复中提到的材料是否满足要求
- `reply_handling_preferences` (object, required; source `user_input`, acquisition `request_user`): 用户希望以什么方式处理不同回复、多少天内响应、以及哪些回复想先看不想直接处理

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 加载并校验输入

- 读取 application_tracking_ledger、verified_opportunity_list、tailored_application_packages、reply_handling_preferences。
- 确认 ledger 为 object 且包含可按机会聚合的记录；确认 verified_opportunity_list 为 array 且可按机会 id 建立映射。
- 若任一必要输入缺失或类型不符，返回 insufficient_input；若 ledger 存在但没有任何可识别的机会记录，也返回 insufficient_input。

Success criteria:

- 四个输入均可解析，verified_opportunity_list 已建立 opportunity_id 到机会对象的映射。

### 2. 提取回复相关事件

- 遍历 ledger 中每个机会的最新状态记录，保留含最新状态、更新时间和来源的条目。
- 过滤掉与回复无关的状态，如仍标记为尚未投递或投递后无任何回复线索的记录。
- 把可以被识别为回复的记录绑定到 verified_opportunity_list 中的机会；无法绑定到任何已验证机会的记录不进入总览。

Success criteria:

- 得到一组绑定到已验证机会的回复候选条目，每条保留来源机会、最新状态、source 和 updated_at。

### 3. 归类回复类型并推导动作与截止时间

- 根据最新状态文本做语义归类：面试邀约→interview_invitation，婉拒或关闭→decline，需要补充材料→material_request，等待对方回复→waiting，需要跟进→follow_up_required，需要用户回复→reply_pending，明确录用→offer_received。
- 按回复类型生成 required_action；材料请求类必须对照 tailored_application_packages 判断材料是否已有，缺失则写 material_hint 提示用户确认。
- 按用户偏好计算 due_time：能获得事件日期的用事件日期加用户设定的响应窗口；对方给了明确截止日的直接使用；两者都不可得时写“未明确”，绝不编造日期。

Success criteria:

- 每条回复候选都有 response_type、required_action 和确定的 due_time 或“未明确”标记。

### 4. 按紧急度排序

- 高优先级：面试邀约、需要立即确认的录用或婉拒、有明确截止日的材料请求。
- 中优先级：reply_pending、follow_up_required、无明确截止日的材料请求。
- 低优先级：waiting、只需告知收悉的 decline。
- 组内排序：有明确 due_time 的在“未明确”之前，due_time 较早的在前；仍并列时按 source_opportunity_id 字典序保持稳定顺序。

Success criteria:

- digest 数组按高、中、低优先级排序，且高优先级中有明确截止时间的条目排在同类中较早位置。

### 5. 汇总输出并返回

- 为每条生成一项 response_action_digest，字段包括 source_opportunity_id、response_type、reply_summary、required_action、due_time、priority、source、updated_at，必要时加 material_hint。
- 按 dedupe_key source_opportunity_id|response_type|required_action|due_time|priority 去重，同名机会的最新回复优先保留。
- 调用 ReturnSkillResult 一次，返回结构化数组；不输出额外文件或其他总结。

Success criteria:

- 返回的数组可直接消费，且未对任何输入或外部系统产生副作用。

## Decision rules

- 回复类型映射只依据 ledger 中的最新状态文本和 next_action 字段，不依据猜测。
- priority 排序规则固定为：高优先级（interview_invitation、offer_received、带明确截止日的 material_request、需要及时确认的 decline）> 中优先级（reply_pending、follow_up_required、无截止日的 material_request）> 低优先级（waiting、仅告知收悉的 decline）。
- due_time 要么来自对方给出的明确时间，要么来自用户偏好窗口加事件时间，要么标记为“未明确”；禁止使用当前日期推断或推算用户没有提供的时间。
- material_request 的 material_hint 只能引用 tailored_application_packages 中确实存在的材料或明确缺失的材料，不能假装用户拥有某份材料。
- 同一机会存在多条回复时，以 updated_at 最新的记录为准，并保留该记录来源。

## Outcome rules

### Success

- 至少有一条可被识别并绑定到已验证机会的回复记录
- 返回的 response_action_digest 为排序后的数组，每项含来源机会、回复类型、回复要点、动作、截止时间和优先级
- 所有 due_time 要么有输入依据，要么明确标记为“未明确”

### Insufficient input

- application_tracking_ledger 缺失、为空或无法解析
- verified_opportunity_list 无法用于绑定任何 ledger 记录
- reply_handling_preferences 缺失且导致无法推导任何默认响应方式

### Error

- 输入字段类型与声明不符且无法安全解析
- 输出序列化失败或返回结构无法被标准 JSON 解析
- 出现无法归入任一回复类型的冲突状态且没有 next_action 可作依据


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "response_action_digest": {
    "type": "array",
    "description": "按紧急度排序的回复处理总览，含来源机会或联系人、回复要点、需要用户做的动作和截止时间"
  }
}
```

Declared consumers:
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- response_action_digest 中每个 source_opportunity_id 都能在 verified_opportunity_list 中找到对应机会。
- 每个条目的 required_action、response_type 和 priority 均来自确定性规则，没有空值。
- 每个条目的 due_time 要么有输入依据，要么显示为“未明确”。
- 每个条目都保留了 source 和 updated_at 来源字段。
- 本次调用没有写入文件、没有调用其他技能或普通工具、没有修改任何外部状态。
