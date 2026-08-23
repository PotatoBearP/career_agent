---
name: compare-opportunity-targets
description: "当用户点名要比较两个以上已确认的机会、并希望知道现阶段哪个最值得优先投递或重点准备时使用。典型请求是“帮我比较这几个岗位机会，看哪个最值得现在投”。不得用于比较内推渠道或联系人、重新生成机会清单、核验机会真实性、规划长期学习、或推荐新的机会。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 岗位机会综合比较与投入优先级评估

机会比较评估员：只对调用时已提供的候选机会、用户标准、用户画像和既有投递优先级做证据化的比较判断，不做探询、不做市场调研、不做投递动作。

## Goal

在用户指定的若干已确认真实机会中，按用户明示的比较维度，结合个人背景与既有投递优先级，得出哪些机会值得优先投入的明确建议、逐条理由和取舍说明。

## Hard boundary

- 只使用本 Skill 声明的输入：candidate_opportunity_ids、verified_opportunity_list、opportunity_pursuit_ranking、user_profile、comparison_criteria；不得调用 WebSearch、WebFetch 或其他工具/Skill
- 不得修改 user_profile、verified_opportunity_list、opportunity_pursuit_ranking 或任何外部状态；本调用是只读决策
- 不得编造机会事实、用户偏好、比较维度、权重或能力证据；任何缺失都标记为 unknown 或触发 insufficient_input
- 不得用一个候选的单一优势替代完整比较；每条建议必须基于逐维度证据并带理由
- 场景域保持开放；user_profile 中的个人证据不得被当作目标行业、目标岗位或目标赛道的默认定义

In scope:

- 解析用户指定的候选机会标识并从 verified_opportunity_list 中取出完整机会事实
- 冻结并规范化用户明示的比较维度与权重
- 用 user_profile 中的真实约束和能力证据判断每个候选机会的适配度
- 用 opportunity_pursuit_ranking 作为交叉印证信号并记录冲突
- 输出 recommendation、per-candidate reasons、tradeoffs、unknowns 和 criteria_version

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `candidate_opportunity_ids` (array, required; source `user_input`, acquisition `request_user`): 用户指定的待比较机会标识，可引用已有机会清单中的对象
- `verified_opportunity_list` (array, required; source `upstream_artifact`, asset `verified_opportunity_list`, acquisition `provided`): 用户已经确认的真实机会清单，用于按标识取出待比较机会的完整信息
- `opportunity_pursuit_ranking` (array, required; source `upstream_artifact`, asset `opportunity_pursuit_ranking`, acquisition `provided`): 用户已确认的机会投递优先顺序，用于与本次比较结果互相印证
- `user_profile` (object, required; source `upstream_artifact`, asset `user_profile`, acquisition `provided`): 用户已有的画像信息，用于判断每个候选机会与用户的匹配程度
- `comparison_criteria` (object, required; source `user_input`, acquisition `request_user`): 用户重视的维度，例如现阶段价值、时间成本、接触难度、与目标方向的一致性等

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 解析并锁定候选机会

- 读取 candidate_opportunity_ids，要求它是包含至少两个不同机会标识的数组
- 逐个在 verified_opportunity_list 中按机会的稳定标识字段查找，完整保留查到的事实及其来源位置
- 若任一候选标识无法解析、或可解析候选不足两个、或数组为空，不要猜测，直接进入 insufficient_input

Success criteria:

- 至少两个候选机会被解析
- 每个候选都关联到 verified_opportunity_list 中的原始事实

### 2. 冻结比较标准

- 读取 comparison_criteria，要求是非空对象且至少包含一个用户关心的维度
- 只使用该对象中出现的维度；不得从 user_profile 推导新的隐含维度
- 记录每个维度是否有用户显式权重；没有显式权重时，按“等权”处理并在 assumptions 中写明
- 计算 criteria_version：把维度名按字典序排序后拼接，并追加标记 explicit_weights 或 equal_weights

Success criteria:

- criteria_version 已确定
- 比较维度列表与用户输入一致，无新增无遗漏

### 3. 抽取每个候选的证据

- 对每个候选，只提取 verified_opportunity_list 中真实存在的字段作为评估证据
- 把 user_profile 中的内容只当作个人约束或适配证据（如已有能力、可用时间、地点偏好），并引用对应的画像字段
- 对任何维度上缺失的证据，标记为 unknown；不得用常识或记忆补全
- 在内部形成证据表：candidate_id -> criterion -> evidence fields -> unknown fields

Success criteria:

- 每个候选在任一维度上的评估都有明确证据或 unknown 标记
- 所有证据都能追溯到具体输入字段

### 4. 逐维度比较并确定优先级

- 对每个冻结维度，给每个候选标注 clear_advantage、comparable、disadvantage 或 uncertain，并引用支撑证据字段
- 汇总时采用用户显式权重；若没有显式权重，按等权汇总，且只有非 uncertain 的评估计入优势比较
- 用 opportunity_pursuit_ranking 交叉印证：若某候选在既有投递优先级中明显靠前，可作佐证；若与本次标准结论冲突，记录到 tradeoffs，不静默覆盖
- 若得分存在并列，不虚构唯一胜者，输出并列候选及各自适合的条件

Success criteria:

- 推荐顺序可被逐维度证据和权重规则解释
- ranking 冲突已进入 tradeoffs

### 5. 组装结果并返回

- 构造 opportunity_comparison_result：criteria_version、candidates（含逐维度评估与证据引用）、recommendation、reasons、tradeoffs、unknowns、assumptions
- recommendation 必须指向一个候选或明确列出并列候选，并附上为何现在投入的理由
- 执行 final_checks，然后调用 ReturnSkillResult 一次，传入 skill_call_id、skill_name 和该结果

Success criteria:

- 输出对象包含全部必填字段
- 没有修改任何上游产物；没有外部调用
- 恰好一次 ReturnSkillResult

## Decision rules

- criteria_version = 按字典序排序的维度名拼接结果 + explicit_weights 或 equal_weights 标记
- 权重：用户显式给出权重则按其计算；未给出则等权，并在 assumptions 中声明“等权假设”
- 未知处理：某候选在某维度没有证据时标 uncertain，不计入优势或劣势，也不可被脑补成优势
- ranking 佐证：只有候选在 opportunity_pursuit_ranking 中的相对位置清晰时，才可用作排序佐证；冲突时记录到 tradeoffs，以用户明示标准为主
- 并列处理：汇总后得分相同则推荐并列，并给出各自更适合的条件；禁止随机或凭印象选出单一胜者

## Outcome rules

### Success

- 至少两个候选解析成功
- comparison_criteria 非空且至少一个维度
- 结果包含 criteria_version、candidates、recommendation、reasons、tradeoffs、unknowns、assumptions
- 所有建议理由可追溯到输入证据字段

### Insufficient input

- candidate_opportunity_ids 为空、缺失或非数组
- 可解析的候选少于两个
- 存在 candidate_opportunity_ids 中的标识在 verified_opportunity_list 中找不到
- comparison_criteria 缺失或为空对象
- verified_opportunity_list、opportunity_pursuit_ranking 或 user_profile 缺失或不可用

### Error

- 组装结果时发生结构化或序列化失败
- 尝试在只读边界外写入或修改外部状态后无法回滚


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "opportunity_comparison_result": {
    "type": "object",
    "description": "按用户标准比较候选机会，给出优先建议、理由和权衡说明"
  }
}
```

Declared consumers:
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- 恰好调用一次 ReturnSkillResult，调用后不再追加指导
- 每条 reason 都引用 candidate_id + verified_opportunity_list 或 user_profile 的具体字段，无凭空断言
- comparison_criteria 中每个维度都出现在候选评估或 unknowns 中，未引入额外隐式维度
- recommendation 明确指向一个候选或并列候选，并列时不虚构唯一胜者
- 输出对象包含 candidate_opportunity_ids、criteria_version、candidates、recommendation、reasons、tradeoffs、unknowns、assumptions
- 未修改 user_profile、verified_opportunity_list、opportunity_pursuit_ranking，也未触发任何外部系统变更
