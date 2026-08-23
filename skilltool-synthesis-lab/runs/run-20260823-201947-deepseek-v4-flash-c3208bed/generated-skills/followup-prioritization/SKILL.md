---
name: followup-prioritization
description: "当用户说“帮我整理投递情况，告诉下一步该跟进谁”“这周该跟进谁”“哪些还没投、哪些该等、哪些该催一催”时使用。不用于录入或修改状态、撰写完整联系消息、实际发送消息或投递材料，也不用于没有投递记录的空泛规划。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 求职进展复盘与跟进优先级分析

子模型承担投递状态判读与跟进优先级调度员角色，只基于调用时提供的台账、优先级、偏好和时间预算生成可执行的排序建议，不充当招聘平台、消息发送器或状态存储系统。

## Goal

基于用户当前的投递状态台账、机会优先级、跟进偏好和可投入时间，生成一份按紧迫度和价值排序的跟进清单，每条动作包含具体动作、建议时限和下一步操作，直接供用户执行或继续编辑。

## Hard boundary

- 只使用 application_tracking_ledger、opportunity_pursuit_ranking、user_followup_preferences、user_available_time 四个输入；不读取用户画像文件、工作区文件、网页或其他普通工具结果。
- 不实际发送、投递、撤回或修改任何外部系统状态；本能力只返回清单。
- 不得编造机会、状态、联系人、回复内容、跟进节奏或具体绝对日期；凡台账未提供的信息都不得虚构。
- 用户明确标注不想打扰的联系对象不得出现在任何联系类动作中。
- 输入缺失或无法判读时返回 insufficient_input，不得用猜测补全后强行生成成功计划。

In scope:

- 读取用户提供的投递状态台账，将每个机会归类到尚未投递、已投递、等待回复、需要跟进、进入面试、已结束六类状态
- 结合机会投递优先级计算每个机会的跟进价值与紧迫度
- 根据用户跟进偏好和可用时间确定动作渠道、建议顺序和时限
- 输出按优先级排序的跟进动作清单，每条含机会、动作类型、优先级、时限和具体下一步

The scenario alone defines the domain (`explicit`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `application_tracking_ledger` (object, required; source `user_input`, acquisition `request_user`): 用户的追踪记录，由用户直接提供当前版本，包含各机会的状态和下一步动作
- `opportunity_pursuit_ranking` (array, required; source `upstream_artifact`, asset `opportunity_pursuit_ranking`, acquisition `provided`): 用户已确认的机会投递优先顺序，用于计算跟进价值
- `user_followup_preferences` (object, required; source `user_input`, acquisition `request_user`): 用户偏好的联系渠道、时间段、频率和不想反复打扰的对象
- `user_available_time` (object, required; source `user_input`, acquisition `request_user`): 用户可投入跟进的时间窗口或总体时间上限，具体数值由用户提供

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 校验并冻结输入

- 检查 application_tracking_ledger 是否为对象且至少包含一个 opportunity_id 记录；记录中至少存在 latest_status、status 或事件列表之一。
- 检查 opportunity_pursuit_ranking 是否为数组且项目顺序可解释为优先级顺序。
- 检查 user_followup_preferences 和 user_available_time 是否包含可用的渠道、频率或时间约束。
- 任一必需输入缺失或为空时停止，并返回 insufficient_input。

Success criteria:

- 四个输入均被确认存在且结构可用
- 未进行任何外部检索或文件读取

### 2. 归一化每个机会的状态阶段

- 对台账中每个 opportunity_id，按记录的 latest_status 或状态事件归入六类之一：尚未投递、已投递、等待回复、需要跟进、进入面试、已结束。
- 若记录本身带 next_action 或 followup_due，则优先据此判断为需要跟进或等待回复。
- 状态字段缺失且事件不足以判断时，将该条标记为状态不明，不强行猜测。

Success criteria:

- 每个机会都得到唯一 status_phase
- 所有状态均来自台账字段或合法推断，没有凭空新增

### 3. 计算动作类型与优先级

- 按状态阶段映射动作类型：尚未投递对应 prepare_and_submit；已投递或等待回复且未到期对应 wait_for_response；需要跟进对应 follow_up；进入面试对应 prepare_for_interview；已结束对应 close_or_archive。
- 若等待回复记录的 next_action 或 followup_due 表明已到期或需要主动催问，则将动作类型改为 follow_up。
- 按确定性排序键排序：先按动作紧迫度，再按 opportunity_pursuit_ranking 中的机会价值顺序，最后按台账给出的 due_time 或跟进节奏决定并列次序。
- 对用户明确标注不想打扰的对象，任何联系类动作直接排除，不得仅靠降低优先级保留。

Success criteria:

- 每条机会都有单一 action_type
- 排序可以由紧迫度、机会价值、时限和用户偏好解释

### 4. 生成清单字段

- 为每个计划项填写 opportunity_id、action_type、priority_score、due_time、next_action，并保留台账中的 source 与 updated_at。
- next_action 必须具体且可执行，例如“通过用户偏好的渠道发送跟进消息询问进展”“按邀约时间准备面试问题”“整理并提交该机会的申请材料”。
- due_time 优先使用台账中的明确日期；无明确日期时按 user_followup_preferences 中的节奏写成相对时限，例如“3个工作日内”。
- 根据 user_available_time 标记本轮建议执行项 this_round=true；超出可投入上限的动作标记 this_round=false 作为顺延项。

Success criteria:

- 每个计划项满足机会、动作类型、优先级、时限、下一步五要素
- 没有为已结束机会生成实际跟进动作

### 5. 核对并返回结果

- 检查已结束机会以外的所有台账机会都出现在计划中，且已结束机会仅作为状态说明出现或不出现。
- 核对排序是否符合决策规则，确认排除对象没有出现在联系动作中。
- 确认本能力未执行任何发送、提交或状态变更动作。
- 调用 ReturnSkillResult 恰好一次，携带 skill_call_id 与 skill_name。

Success criteria:

- 计划可直接被用户理解并执行
- 所有核对项通过后只返回一次结果

## Decision rules

- 状态映射：尚未投递=prepare_and_submit；已投递或等待回复且未到期=wait_for_response；需要跟进或已到期=follow_up；进入面试=prepare_for_interview；已结束=close_or_archive。
- 紧迫度排序（低值表示更优先）：respond_to_reply=1，prepare_for_interview=2，follow_up=3，prepare_and_submit=4，wait_for_response=5，close_or_archive=6。
- 并列时按 opportunity_pursuit_ranking 中该机会的先后次序排序；数组中越靠前越优先。
- 台账中明确 due_time 的机会优先于仅有相对节奏机会的同级项。
- 用户排除对象优先于一切排序规则，不得生成联系类动作。
- 不依据当前墙钟时间推算超时；未提供明确日期时只输出相对时限，保持不确定性可见。

## Outcome rules

### Success

- 四类输入均存在且可判读
- 至少一个非已结束机会能够生成合法动作，或所有机会已结束且返回空清单并说明无需跟进
- 计划数组按决策规则排序，每项包含 opportunity_id、action_type、priority_score、due_time、next_action

### Insufficient input

- application_tracking_ledger 缺失或为空
- opportunity_pursuit_ranking 缺失或为空
- user_followup_preferences 或 user_available_time 缺失，且无法判断渠道、节奏或可投入范围
- 台账中机会的状态全部无法判读

### Error

- application_tracking_ledger 不是 JSON 对象
- opportunity_pursuit_ranking 不是 JSON 数组
- 无法序列化输出计划


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "prioritized_followup_plan": {
    "type": "array",
    "description": "按优先级排序的跟进动作，含机会、动作类型、建议时限和具体下一步"
  }
}
```

Declared consumers:
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- prioritized_followup_plan 中每个对象的 opportunity_id、action_type、priority_score、due_time、next_action 均非空。
- 计划中出现的每一个 opportunity_id 都能在 application_tracking_ledger 或 opportunity_pursuit_ranking 中找到。
- 用户明确排除的对象没有出现在任何联系类动作中。
- 排序符合决策规则中的紧迫度、机会价值和时限次序。
- 没有执行任何消息发送、材料投递、撤回或状态修改动作。
- 所有已结束机会均未生成实际跟进动作。
