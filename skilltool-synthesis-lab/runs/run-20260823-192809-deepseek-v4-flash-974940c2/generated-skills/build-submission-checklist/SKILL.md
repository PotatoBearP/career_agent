---
name: build-submission-checklist
description: "当用户已完成岗位材料准备、临近投递，明确要求一份提交前逐项核对清单时使用；也适用于用户已从‘梳理岗位要求交什么材料’产出 material_requirements，想把它转成可执行检查表的情况。不得用于生成或改写简历/求职信内容、核验材料事实是否夸大、代替用户提交或发送材料，也不得重新梳理岗位要求。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 做一张提交前核对清单

投递前的材料核验员：只做‘要求 ↔ 已备材料’的逐项匹配与清单化，不评判材料内容真假，不产生任何新材料也不触发任何外部发送动作。

## Goal

把已梳理的岗位材料要求与用户当前已准备的材料逐项对齐，生成一份提交前可逐项打勾的核对清单，每项包含材料名称、要求说明、当前状态、核对动作和截止时间，方便用户在投递前完成最终确认。

## Hard boundary

- 只读取并组合 task 声明的 material_requirements、prepared_materials、submission_context 三个输入，不读取用户画像、岗位清单、历史任务输出之外的信息；不重新提炼或改写 material_requirements 中的要求语义
- 不得编造清单项：任何材料种类、格式约束、篇幅限制、命名规则、截止时间都必须来自 material_requirements 或 submission_context，否则标注为 unsupported 并要求用户补充，不能猜测
- 不得把岗位要求改写成用户已具备的能力，不得把用户尚未完成的事项标为已完成，只能使用 prepared_materials 中已有的文档类型、格式状态和完成标志
- 不得代替用户提交、发送或导出材料，输出只是供用户勾选和执行的清单
- 不执行事实核验：发现材料表述可疑时只在说明中提示用户自查，不判定编造或夸大

In scope:

- 把 material_requirements 中的每类材料转换为核对条目
- 用 prepared_materials 逐项匹配并判定当前状态
- 按 submission_context 补充投递平台相关的通用核对动作
- 为每条生成可执行的核对动作与截止时间
- 按截止时间和必需/可选要求排序后输出结构化核对清单

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `material_requirements` (object, required; source `prior_skill_output`, asset `material_requirements`, acquisition `prior_skill`): 已梳理出的岗位材料要求清单，包含材料种类、格式约束、篇幅要求和截止时间
- `prepared_materials` (array, required; source `user_input`, acquisition `request_user`): 用户当前已准备的材料清单，每项注明文档类型、格式状态和是否完成
- `submission_context` (object, required; source `user_input`, acquisition `request_user`): 用户提供的投递平台、提交方式以及是否包含额外步骤；未提供时按通用投递流程生成核对项

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 校验输入快照

- 确认 material_requirements 为 object 且包含可识别的材料条目；若无或为空，直接进入 insufficient_input 结果
- 确认 prepared_materials 为 array；若用户完全未提供，进入 insufficient_input 结果
- 读取 submission_context；缺失时设定为通用投递上下文并记录 generic_check 标记

Success criteria:

- material_requirements 至少含一个材料条目，prepared_materials 可用；提交方式已知或已明确按通用方式处理

### 2. 逐条生成要求核对项

- 遍历 material_requirements 中的每个材料条目，抽取 material_name、requirement_note、format_constraint（若有）、deadline（若无则置 null）
- 为每个材料条目生成 check_action，内容是从该条要求推导出的可执行核对动作，格式如‘核对文件格式是否符合要求、确认文件命名与语言、确认内容为最终版’
- 若 material_requirements 中出现无法归类的字段，不丢弃，放入该条目 requirement_note 或附加字段 source_note，不新增虚构要求

Success criteria:

- material_requirements 中每条可识别材料都对应一个清单条目；每条含 material_name、requirement_note、check_action、deadline 字段

### 3. 匹配已备材料并判定状态

- 按文档类型或名称把 prepared_materials 中的条目匹配到对应核对项；一条已备材料可匹配多个核对项时，在每个相关项上引用同一来源
- 状态判定规则：未在 prepared_materials 中找到匹配 → current_status=not_prepared；找到匹配但格式状态或完成标志不满足要求 → current_status=needs_review；找到匹配且格式状态与完成标志满足 → current_status=ready
- 对 needs_review 的项，check_action 中追加具体待确认点（如文件格式、命名、页数、语言）
- 匹配不到任何已备材料的核对项不得改为 ready

Success criteria:

- 每个核对项的 current_status 只来自 prepared_materials 的匹配结果或 not_prepared；没有凭空标记 ready 的情况

### 4. 合成排序与补充通用核对项

- 若 submission_context 提供平台或提交方式，追加对应通用核对动作（如确认上传附件数、填写表单字段、检查提交按钮前的预览页面）并标记为 generic_check
- 排序规则：先按 deadline 升序；deadline 相同的按是否必需/重要排序（material_requirements 中标记为必需或硬性的在前）；无 deadline 的排在有 deadline 的之后
- 保持每个条目字段结构一致，且排序结果可解释：在结果对象中附 sort_basis 字段说明排序依据

Success criteria:

- 输出数组中的条目字段名一致；排序规则已应用；generic_check 项与 requirement 项可区分

### 5. 返回前校验

- 检查每个条目均包含 material_name、requirement_note、current_status、check_action、deadline 字段
- 确认所有要求说明和格式约束均来自 material_requirements 或 submission_context，没有新增未知材料类型
- 确认 current_status 只取 not_prepared、needs_review、ready 三值之一
- 确认结果中没有‘我已提交’、‘已发送’等外部动作声明；确认未触碰上游产物
- 按 Harness 约定的 envelope 调用 ReturnSkillResult 一次并返回 submission_checklist 数组

Success criteria:

- 所有 final_checks 成立且恰有一次 ReturnSkillResult

## Decision rules

- current_status 取值固定为 not_prepared|needs_review|ready
- 匹配规则：以 prepared_materials 中 document_type/name 与材料条目名称的语义等价为准，不做模糊泛化；命名差异但语义明确等价时可视为匹配并在 source 字段记录
- 排序规则：deadline 升序 > 必需项优先 > 无 deadline 最后
- deadline 缺失一律置 null，不得用当前日期或任意日期填充
- generic_check 项只允许来自 submission_context 或通用投递流程的默认动作

## Outcome rules

### Success

- material_requirements 存在且至少含一个材料条目
- prepared_materials 已提供
- submission_checklist 为数组且每个条目包含 material_name、requirement_note、current_status、check_action、deadline 字段
- 所有要求来源可追溯到输入，无编造项

### Insufficient input

- material_requirements 缺失、为空或无法识别任何材料条目
- 用户未提供 prepared_materials 且无法判定任何材料的当前状态
- submission_context 缺失时并不构成 insufficient_input，仅使用通用核对动作

### Error

- 输入类型不符合声明（如 material_requirements 不是 object、prepared_materials 不是 array）
- 序列化失败或 ReturnSkillResult 前结构校验失败


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "submission_checklist": {
    "type": "array",
    "description": "逐项核对清单，每项包含材料名称、要求说明、当前状态、需要执行的核对动作和截止时间"
  }
}
```

Declared consumers:
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- None.
