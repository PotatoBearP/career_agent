---
name: application-tracking-status-recorder
description: "当用户报告某机会发生了投递、回复、面试、跟进或关闭动作，并要求更新记录或记下该跟进的时机时使用。用户只问统计、排序、提醒，或只要求查看下次该联系谁时不要使用。未提供事件内容或没有可关联的已验证机会时不要强行产出新状态。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 求职进展与跟进状态记录

投递状态管理员：把用户提供的杂乱进展事件整理成每个机会的一条可追踪状态记录，并给出下一步动作；只做状态记录与提醒，不执行任何外部动作。

## Goal

把用户口述或粘贴的投递、回复、面试、跟进、关闭事件增量合并进已有台账，并输出每个机会的最新状态、状态来源、更新时间、下一步动作和提醒依据，且始终不修改已验证机会清单或投递材料。

## Hard boundary

- 不得修改 verified_opportunity_list、user_profile、tailored_application_packages、material_quality_report 或任何上游产物；只能产出新的 application_tracking_ledger。
- 不得实际发送、投递、撤回或修改外部系统状态；所有结果只以草稿台账、下一步动作和提醒依据形式返回。
- 不得猜测联系方式、私人信息、共同经历或虚构事件来源；用户未提供的时间、来源、联系人一律保持 null 或 unknown。
- 不得用系统当前时间代替用户未提供的更新时间；缺少时间时在 updated_at 中写 null，并把缺口写入 warnings。
- 不得为已验证机会清单之外的对象创建状态记录；无法关联的事件只能进入 unresolved_events，不能静默归入某个机会。

In scope:

- 把 status_update_events 解析成可处理的事件并关联到 verified_opportunity_list 中的机会
- 把 current_tracking_records 作为既有台账增量合并，而不是覆盖
- 将每个机会归类为 not_applied、applied、waiting_reply、needs_followup、in_interview、closed 之一
- 基于 user_followup_cadence 计算 next_action 和 reminder_basis
- 保留用户提供的事件来源、更新时间和原始摘要，缺失字段保持 null 或 unknown
- 输出 application_tracking_ledger 结构化台账

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `status_update_events` (array, required; source `user_input`, acquisition `request_user`): 用户口述或粘贴的投递、回复、面试、跟进、关闭事件，时间和来源由用户提供
- `current_tracking_records` (object, required; source `user_input`, acquisition `request_user`): 用户已有的追踪记录，可为空，用于增量更新而不是覆盖
- `verified_opportunity_list` (array, required; source `upstream_artifact`, asset `verified_opportunity_list`, acquisition `provided`): 用户已经确认的真实机会清单，用于关联每一条状态记录到正确机会
- `user_followup_cadence` (object, required; source `user_input`, acquisition `request_user`): 用户希望多久跟进一次、用什么方式跟进，具体节奏由用户提供

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 解析事件并建立最小字段集

- 遍历 status_update_events，为每条事件提取 opportunity_reference、event_type、occurred_at、source、raw_summary 和 result_detail。
- event_type 限定为 submitted、received_reply、interview_scheduled、followup_marked、closed_by_user、closed_by_employer、other；无法归类时写 other 并保留 raw_summary。
- occurred_at 和 source 只使用用户提供的原文；缺失时置 null，不推导、不补默认值。
- 若 status_update_events 为 null、空数组或全部条目缺少可识别文本，则进入 insufficient_input 判定。

Success criteria:

- 每条事件都有规范化 event_type 字段，且至少保留 opportunity_reference 或 raw_summary 之一
- 缺失字段已明确标记为 null，未出现补造的时间或来源

### 2. 关联到已验证机会

- 使用 verified_opportunity_list 作为唯一机会主数据；先按输入中的机会 id 精确匹配，再按机会名称、公司或公开链接做完全字符串匹配。
- 为每条已关联事件记录 match_method，取值为 exact_id、exact_name、exact_url 或 resolved_from_original。
- 无法匹配的事件放入 unresolved_events，附带 raw_summary 和无法匹配的原因；不要猜测属于哪个机会。
- 若所有事件都无法匹配且 current_tracking_records 为空，返回 insufficient_input，列出缺失的可匹配标识。

Success criteria:

- 所有可解析事件均持有 verified_opportunity_list 内的 opportunity_id
- unresolved_events 只包含真实无法匹配的条目，并说明原因

### 3. 合并增量状态并归类

- 读取 current_tracking_records 作为基线；把每条已解析事件按机会合并进 event_history，并按用户提供的 occurred_at 排序。
- 同一机会有多条事件时，以用户提供的最新 occurred_at 为准；时间相同时以输入数组中更靠后的事件为准，并写入 warnings 标注时间歧义。
- 依据事件类型把 latest_status 归入 not_applied、applied、waiting_reply、needs_followup、in_interview、closed 之一：未投递为 not_applied；投递行为为 applied；已投递且明确在等回复为 waiting_reply；用户明确说该跟进或等待超过其设定节奏为 needs_followup；收到面试安排为 in_interview；收到婉拒、撤回或放弃为 closed。
- 若事件属于收到非面试回复或补充材料请求，latest_status 保持 waiting_reply，next_action 写按要求补充材料。

Success criteria:

- 每个机会的 latest_status 都属于六值枚举
- event_history 按用户提供的时间排序，歧义已记录到 warnings

### 4. 计算下一步动作与提醒依据

- 根据 latest_status 和 user_followup_cadence 生成 next_action：not_applied 写按机会优先级决定是否投递；applied 写等待回复并按确认节奏检查；waiting_reply 写等待回复，若 cadence 存在则写按节奏到期后跟进；needs_followup 写按用户偏好渠道跟进；in_interview 写准备并参加面试、留意后续通知；closed 写结果已归档，不再安排跟进。
- 仅当 user_followup_cadence 提供了可复用节奏或用户明确提到跟进期限时，reminder_basis 才写具体依据；否则置 null。
- 不得因为缺少 reminder_basis 而把 next_action 清空；next_action 始终是普通用户可读的具体动作。

Success criteria:

- 每条记录都有非空 next_action
- reminder_basis 只在有真实依据时填写，否则为 null

### 5. 校验并输出台账

- 组装 application_tracking_ledger，包含 schema_version、opportunities、unresolved_events、warnings；opportunities 以 opportunity_id 为键，每条含 latest_status、status_source、updated_at、next_action、reminder_basis、event_history。
- 校验每个 opportunity_id 均来自 verified_opportunity_list，latest_status 均属六值枚举，next_action 均为非空字符串。
- 校验 updated_at 和 status_source 没有补造值，缺失字段保持 null。
- 确认没有修改任何上游产物、没有写入文件、没有调用外部服务后，调用 ReturnSkillResult 恰好一次。

Success criteria:

- application_tracking_ledger 可直接被用户或后续系统消费
- 所有引用均可追溯，且未越界修改任何外部状态

## Decision rules

- 状态归类只允许六值：not_applied、applied、waiting_reply、needs_followup、in_interview、closed；其他描述必须映射到这六类，映射不了的放入 warning。
- 同一机会冲突时，以用户提供的最新 occurred_at 为准；同时或不完整时以数组靠后事件为准并写 warning，绝不静默丢弃旧信息。
- 未提供 user_followup_cadence 时，needs_followup 只能来自用户明确说该跟进，不能由系统时间自动推导。
- 所有事件必须能关联到 verified_opportunity_list；无法关联的进入 unresolved_events，若全部无法关联且无既有台账则 insufficient_input。

## Outcome rules

### Success

- 存在至少一条可解析且可关联的事件，或 current_tracking_records 非空
- 已产出 application_tracking_ledger，每个机会都有六值枚举状态和具体 next_action
- 无法关联的事件已进入 unresolved_events，信息未丢失

### Insufficient input

- status_update_events 为 null 或空数组，且 current_tracking_records 为空
- 所有事件都无法关联到 verified_opportunity_list，且 current_tracking_records 为空
- verified_opportunity_list 缺失或为空，导致无法确定状态记录归属

### Error

- 序列化失败或输出结构无法被 JSON 解析
- 尝试写文件、调用外部系统或修改上游产物而被中止
- 返回结果时未包含完整 opportunities 结构


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "application_tracking_ledger": {
    "type": "object",
    "description": "按机会聚合的状态记录，含最新状态、来源、更新时间、下一步动作和提醒依据"
  }
}
```

Declared consumers:
- task_synthesize_response_digest
- task_record_meeting_outcomes
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- 每个 opportunity_id 均存在于 verified_opportunity_list，或对应事件已进入 unresolved_events
- 每条记录的 latest_status 均属于六值枚举，且 next_action 为非空字符串
- status_source 和 updated_at 保留用户原值，缺失为 null，无任何补造值
- application_tracking_ledger 可被 JSON 序列化，且未修改上游产物或外部系统状态
- 调用 ReturnSkillResult 恰好一次
