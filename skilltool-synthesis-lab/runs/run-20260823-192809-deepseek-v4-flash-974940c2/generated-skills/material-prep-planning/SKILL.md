---
name: material-prep-planning
description: "用户询问先准备哪个岗位的材料、希望把多个岗位的材料准备排出先后顺序，或要求按自己的时间和截止日期安排一份材料准备计划时使用。不用于重新计算岗位投递优先级、不用于改写具体材料内容，也不用于代替用户发送申请材料。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 规划先准备哪些岗位的材料

材料准备排期规划师：只根据冻结输入做计划，不改动任何上游事实，不为用户编造时间投入或岗位要求。

## Goal

基于投递优先顺序、各岗位截止时间、用户每周可投入时间和材料准备要点，产出一份按时间顺序排列的岗位材料准备计划，包含每项行动、预计产出、截止时间和调整依据。

## Hard boundary

- 不得修改或重新生成 opportunity_pursuit_ranking、verified_opportunity_list、application_focus_brief 的任何字段
- 不得自行假设用户每周可投入时间、各岗位截止时间或希望优先的岗位；这些必须来自 user_constraints
- 不得为某个岗位虚构它不存在的材料要求或材料量级，只能依据 verified_opportunity_list 与 application_focus_brief 中明确出现的信息
- 不得输出发送指令、不得代替用户向岗位发送任何材料
- 禁止把所有岗位简单按数量平均分配时间；必须使用截止时间、每周投入时间和投递顺序做显式判断

In scope:

- 读取投递优先顺序、已验证岗位清单、投递材料准备要点
- 读取用户提供的各岗位材料截止时间、每周可投入时间和希望优先处理的岗位
- 按时间顺序生成各岗位材料准备计划，按行动列出预计产出和截止时间
- 标注每个排序决策所依据的输入字段
- 输出可直接编辑、排期使用的结构化计划对象

The scenario alone defines the domain (`explicit`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `opportunity_pursuit_ranking` (array, required; source `upstream_artifact`, asset `opportunity_pursuit_ranking`, acquisition `provided`): 岗位投递优先顺序，作为材料准备排序的输入依据
- `verified_opportunity_list` (array, required; source `upstream_artifact`, asset `verified_opportunity_list`, acquisition `provided`): 已验证的真实岗位机会清单，包含各岗位的基本信息和材料要求来源
- `user_constraints` (object, required; source `user_input`, acquisition `request_user`): 用户提供的各岗位材料截止时间、每周可投入时间、希望优先处理的岗位和可用验证周期
- `application_focus_brief` (object, required; source `upstream_artifact`, asset `application_focus_brief`, acquisition `provided`): 投递材料准备要点，用于估计每个岗位需要准备的材料量

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 解析岗位与投递顺序

- 读取 opportunity_pursuit_ranking 中岗位的排列顺序，逐项在 verified_opportunity_list 中解析出对应的岗位标识、岗位描述来源和材料要求来源
- 记录无法在 verified_opportunity_list 中匹配到的岗位标识，并保留该不匹配项为待确认状态
- 把 application_focus_brief 中与各岗位相关的材料准备要点抽取为material_scope_items

Success criteria:

- 所有可匹配岗位均已建立岗位标识、投递顺序位次、材料要求来源三元组
- 无法匹配的岗位已被单列且标注为待确认

### 2. 读取用户约束

- 从 user_constraints 中读取 weekly_available_hours、各岗位 material_deadlines、preferred_priorities 和可用验证周期字段
- 逐岗位建立 deadline 映射；对未提供截止时间的岗位标记 deadline_null 并用可用验证周期推断相对时间范围，若没有周期则标记无时间约束
- 校验 weekly_available_hours 是否为正数，否则记入 insufficient_input

Success criteria:

- 每个岗位都有 deadline 状态：显式日期、从可用验证周期推导的相对范围、或无时间约束
- 每周可投入时间已通过数值校验或进入 insufficient_input

### 3. 确定排序规则

- 以 opportunity_pursuit_ranking 的顺序为第一序键，确保高投递优先级岗位出现在低优先级岗位之前
- 对距显式截止时间不足一个可用验证周期的岗位，将该岗位的紧急度提升为 urgent；多个 urgent 岗位之间按投递顺序排序
- 对材料量级较大的岗位，使用 application_focus_brief 中的材料准备要点数量与生成篇幅估计其相对工作量，并把该估计写入计划项 rationale
- 对用户明确在 preferred_priorities 中指定的岗位，在其投递顺序位次基础上提升一位，并在 rationale 中记录用户约束导致的上移

Success criteria:

- 计划项顺序可以由「投递顺序 > 紧急度 > 用户显式优先 > 工作量估计」的解释链推导
- 每一条排序改动都能在对应计划项中找到依据字段

### 4. 生成计划对象

- 为每个岗位生成一组动作项，动作名形如「准备岗位X的基础材料」「按岗位X要求改写简历」「补充岗位X的缺失事实」，每个动作的预计产出来自 application_focus_brief 中对应材料条目或 verified_opportunity_list 中材料要求来源
- 按排序后的岗位顺序和每周可用时间把动作项分配到时间槽，时间槽以周为单位，动作跨周时在字段中标注分阶段安排
- 为每个动作写入 deadline、estimated_hours、rationale，rationale 引用触发它的输入字段名：投递位次、截止日期、用户优先或工作量估计
- 把无截止时间且低优先级的岗位动作排在计划末尾，并标记可以延后

Success criteria:

- 输出对象包含 plan_version、generated_at、constraints_snapshot、ordered_steps 数组，其中每个 step 都有岗位标识、动作说明、预计产出、截止时间、预估投入与依据
- ordered_steps 的时间顺序与第 3 步的排序规则一致

### 5. 校验并交付

- 检查每个计划项是否只引用给定输入字段中的信息，不包含任何编造的数字
- 检查所有 deadline 与 user_constraints 中的输入一致，所有岗位标识与 verified_opportunity_list 中的标识一致
- 确认输出中不含发送材料、修改用户画像或修改投递排序的指令
- 调用 ReturnSkillResult 交付 material_prep_plan 对象

Success criteria:

- 输出通过引用完整性与事实一致性检查
- ReturnSkillResult 只调用一次

## Decision rules

- 排序第一序键：opportunity_pursuit_ranking 中岗位出现的从左到右顺序
- 紧急度提升：显式截止时间距离今天短于可用验证周期的岗位标记为 urgent，并整体排在同级岗位之前
- 用户显式优先：preferred_priorities 中出现的岗位，在投递顺序位次不变的前提下，其整体准备动作前移一位，并在 rationale 中写明用户优先
- 工作量估计：以 application_focus_brief 中该岗位材料准备要点的条目数和各条目要求的产出类型（简历、项目表述、求职信、补充材料）估算相对工作量，估计值标注为 estimate 而非事实
- 冲突处理：当用户明确指定优先的岗位与截止日期冲突岗位不一致时，以显式截止日期更近的岗位为 urgent，并在计划中同时保留用户优先岗位作为 no_later_than 后置项
- 时间分配：每项动作的 estimated_hours 之和不得超过每周可投入时间；超出部分按岗位顺序顺延到下一周，并在计划项注明延后

## Outcome rules

### Success

- opportunity_pursuit_ranking、verified_opportunity_list、application_focus_brief、user_constraints 全部可用
- 至少存在一个可解析的岗位，且 weekly_available_hours 为正数
- 能够按第 3 步排序规则生成包含 ordered_steps 的计划对象

### Insufficient input

- 缺少 user_constraints 或其中没有 weekly_available_hours
- opportunity_pursuit_ranking 为空且 verified_opportunity_list 中没有任何岗位可排
- 所有岗位均无截止时间且没有可用验证周期，且用户没有提供任何优先岗位
- 在说明中列出缺失字段，不把缺失写成错误

### Error

- 输入字段本身无法解析为声明的 JSON 类型
- 计划对象序列化失败或 ordered_steps 结构校验失败


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "material_prep_plan": {
    "type": "object",
    "description": "按时间顺序排列的材料准备计划，包含每项行动、预计产出、截止时间和调整依据"
  }
}
```

Declared consumers:
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- output_schema 中的 material_prep_plan 已形成，且仅包含输入字段中可推导的信息
- 所有岗位标识都能在 verified_opportunity_list 中找到，或已被明确标记为待确认
- 每个动作项的 rationale 都引用至少一个具体输入字段名
- 计划中没有任何「代替用户发送」「修改用户画像」「修改投递排序」的表述
- 未使用 task 声明之外的任何额外运行时输入
