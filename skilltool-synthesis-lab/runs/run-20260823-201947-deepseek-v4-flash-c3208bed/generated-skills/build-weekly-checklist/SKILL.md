---
name: build-weekly-checklist
description: "用户已有近期行动计划并想把它拆成本周可执行清单时使用；例如用户说“帮我把计划拆成这周要做的清单”“这周只有零散时间，帮我排下能做什么”。不应代替总体行动规划，不实际发送或投递任何内容，也不应重新生成机会优先级。缺少行动计划、本周标识或本周时间预算时返回 insufficient_input。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 周度求职行动计划编排

周清单编排者：只把已有行动计划与追踪状态翻译成这一周可勾选执行的具体事项，不做新的策略判断、不研究外部世界、不推进实际流程。

## Goal

基于已有行动计划与当前追踪状态，生成一份本周可勾选执行的具体事项清单，每项给出先后顺序、预估耗时、建议完成日和可核验的完成标准。

## Hard boundary

- 输入冻结：只使用 networking_action_plan、current_week_label、weekly_time_budget、current_tracking_records 四个字段；不得读取用户画像、岗位事实、行业信息或任何未提供的文件。
- 不创造新任务：每个 checklist_item 必须能从 networking_action_plan 的某条计划项找到来源；不得添加计划中不存在的泛化动作。
- 不执行外部动作：只生成草稿清单，不实际发送消息、提交投递、创建日历事件或修改任何外部系统状态。
- 不重新规划：不改变计划窗口、机会优先级或总体方向；只从原计划中选择本周内容并排入可用时间。
- 不虚构时间：suggested_day 必须来自 weekly_time_budget 的可用日，estimated_time 必须来自计划提示或由计划项可推断的工作量，缺少依据时不得编造具体时刻。

In scope:

- 从 networking_action_plan 中提取当前周应执行以及过期未完成的事项
- 使用 current_tracking_records 排除已完成事项并区分等待回复、需要跟进、进入面试等状态
- 按计划内优先级与 weekly_time_budget 对本周事项排序、取舍和排入建议日
- 生成带 week_label、checklist_item、suggested_day、estimated_time、done_criteria 的可勾选清单

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `networking_action_plan` (object, required; source `prior_skill_output`, asset `networking_action_plan`, acquisition `prior_skill`): 用户已有产物，是接下来一段时间的接触、联系、投递、跟进和检查点计划
- `current_week_label` (string, required; source `user_input`, acquisition `request_user`): 用户指明的当前周或起止日期，用于确定本周在计划中的位置
- `weekly_time_budget` (object, required; source `user_input`, acquisition `request_user`): 用户这周可投入的总时长和可用的时间段
- `current_tracking_records` (object, required; source `user_input`, acquisition `request_user`): 用户已有的最新追踪记录，可为空，用于判断哪些计划事项已经完成或需要顺延

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 冻结并解析输入

- 读取 networking_action_plan 对象，提取 plan_window、计划项列表、每项优先级、必要的时间提示。
- 读取 current_week_label 字符串、weekly_time_budget 对象和 current_tracking_records 对象（后者可为空对象）。
- 若任一必需输入缺失或结构不可解析，直接进入 insufficient_input，不尝试猜测。

Success criteria:

- 四个字段均已加载且类型正确
- 已得到计划项的完整列表与计划窗口
- 已得到本周时间预算的可用日和总时长

### 2. 定位本周在计划中的位置

- 将 current_week_label 与 networking_action_plan 的计划窗口比较。
- 选出计划窗口中落在本周的计划项，以及计划时间已在本周之前但仍未完成、需要顺延的项。
- 若本周完全落在计划窗口之外且不存在过期未完成项，返回 insufficient_input。

Success criteria:

- 候选清单只包含本周应做或过期未完成的计划项
- 每条候选项都能对应到 networking_action_plan 中的明确来源

### 3. 排除已完成事项并确定状态

- 用 current_tracking_records 按计划项引用查询每条候选项。
- 将状态为已结束、已关闭或显式完成标记的项移出清单。
- 为保留的项记录来源状态，例如等待回复、需要跟进、进入面试、尚未开始；状态仅作排序参考，不改变计划内容。

Success criteria:

- 已结束或显式完成的计划项不在最终清单中
- 保留项均保留了可回源引用和状态说明

### 4. 按优先级排序并按时间预算取舍

- 按 networking_action_plan 中的优先级排序；同为高优先级的，先安排过期项，再按追踪记录中的时限或用户跟进偏好排序。
- 汇总候选项所需时间：优先使用 plan 中给出的估计，否则按事项性质给出保守整数估计，不做虚假精确。
- 当预估总时间超过 weekly_time_budget 总时长时，保留最高优先级子集直到接近预算；未纳入的项不修改原计划，仅延迟到后续周由原计划继续承接。

Success criteria:

- 排序可由计划优先级、过期状态和用户时限解释
- 最终纳入清单的预估时间总和不超过 weekly_time_budget 总时长

### 5. 生成并校验本周清单

- 为每个保留项生成 weekly_execution_checklist 元素，包含 week_label=current_week_label、checklist_item、suggested_day、estimated_time、done_criteria，以及用于回源的 source_plan_item_ref。
- suggested_day 必须来自 weekly_time_budget 的可用日；有外部截止日期的项排在截止日之前。
- done_criteria 必须是可观察、可核验的完成标准，例如“完成该联系消息草稿并与原计划核对内容”。
- 数组顺序即建议先后顺序；只调用一次 ReturnSkillResult 返回该数组。

Success criteria:

- 至少有一个清单项且所有字段完整
- 清单项全部回源到 networking_action_plan
- 未包含任何已结束或已完成的计划项

## Decision rules

- 视为已完成并排除的记录状态：已结束、已关闭、显式 done=true；等待回复、需要跟进、进入面试、已投递等状态不视为完成，只要原计划中仍存在对应后续动作。
- 排序键：计划内优先级为核心/重要/次要三级时按 核心 > 重要 > 次要；同段内先处理过期项，再按追踪记录中的下一步时限；最后用户跟进偏好决定先后。
- suggested_day 只能取 weekly_time_budget.available_days 中的值；若某计划项有明确截止日期且在本周内，则建议日必须不晚于该截止日。
- estimated_time 总和不得超过 weekly_time_budget 总时长；若不足以容纳全部项，只保留最高优先级子集，不把时间分摊到编造的更短时长。
- 任何无法回源到 networking_action_plan 的 checklist_item 一律排除，防止模型自行新增任务。

## Outcome rules

### Success

- 生成了至少一个清单项
- 每个清单项包含 week_label、checklist_item、suggested_day、estimated_time、done_criteria
- 每个清单项均可回源到 networking_action_plan
- 预估时间总和不超过 weekly_time_budget 总时长

### Insufficient input

- 缺少或无法解析 networking_action_plan（无计划项）
- 缺少 current_week_label 或 weekly_time_budget
- current_week_label 不在计划窗口内且不存在过期未完成项

### Error

- current_tracking_records 结构异常导致无法建立计划项到记录的映射
- weekly_time_budget 中缺少可用日或总时长，且无法从解析结果得到确定性预算
- 生成结果序列化失败或无法满足输出结构


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "weekly_execution_checklist": {
    "type": "array",
    "description": "本周可勾选的具体事项，含建议先后、预估耗时、完成标准和每天安排建议"
  }
}
```

Declared consumers:
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- 每个 checklist_item 都能回源到 networking_action_plan，非凭空新增。
- week_label 与 current_week_label 完全一致。
- 所有 suggested_day 都在 weekly_time_budget 的可用日范围内。
- estimated_time 总和不超过 weekly_time_budget 的总时长。
- current_tracking_records 中已结束或已完成的计划项未出现在清单中。
- 只调用一次 ReturnSkillResult，不附带额外指导或后续行动建议。
