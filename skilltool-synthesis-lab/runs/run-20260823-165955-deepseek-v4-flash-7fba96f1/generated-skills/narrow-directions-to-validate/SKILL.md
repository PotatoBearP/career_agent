---
name: narrow-directions-to-validate
description: "用户已经有一组候选方向，并希望从中缩小到少量值得优先投入验证的方向时使用。不用于从零生成候选方向，不用于比较具体岗位细节，不用于判断用户适合某一职位，也不在缺少候选方向或用户画像时猜测生成。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 缩小值得优先验证的方向

方向筛选评估员：把候选方向与用户画像证据做贴合度判断，并按用户给出的或默认的权重排出优先验证顺序。

## Goal

基于用户提供的候选方向、用户画像中的证据与偏好以及调用时给出的取舍权重，输出少量值得优先验证的方向短名单；每个方向给出贴合度、证据充分度、不确定性、取舍理由和下一步验证建议，并保留暂时搁置的方向及其原因。

## Hard boundary

- 不得新增候选方向，只能对 candidate_directions 中已有的方向排序。
- 不得越过 user_profile 推断个人事实；user_profile 未覆盖的信息记为不确定性。
- 不得修改、重述或伪造 user_profile 内容，只引用其中与方向取舍相关的证据、偏好和约束。
- 不得将缺失证据当成用户具备相应条件；不得给某方向下“适合/不适合你”的绝对断言。
- 不得调用 WebSearch、WebFetch 或任何其他普通工具和后续任务输出。

In scope:

- 读取用户提供的 candidate_directions 列表
- 根据 decision_weights 或默认维度计算贴合度排序
- 结合 user_profile 中的证据、偏好和现实约束评估每个方向
- 将方向分为保留、条件保留和搁置，并给出取舍理由
- 为保留方向给出下一步验证建议

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `candidate_directions` (array, required; source `user_input`, acquisition `request_user`): 用户已有的候选方向列表，各项含名称、了解程度与来源
- `decision_weights` (object, required; source `user_input`, acquisition `request_user`): 用户在取舍时看重的因素及相对权重；为空时按默认维度排序
- `user_profile` (object, required; source `upstream_artifact`, asset `user_profile`, acquisition `provided`): 用户画像中的证据、偏好与现实约束，用于判断候选方向的贴合度

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 校验并冻结输入边界

- 检查 candidate_directions 是非空数组，且每个元素有可识别的名称或描述。
- 检查 user_profile 是对象。
- 归一化 decision_weights：若提供则记录各维度权重，否则准备使用默认等权维度。

Success criteria:

- 确认 candidate_directions 非空；每个候选项可被唯一指认。
- 记录将使用哪些评估维度及其权重来源。

### 2. 提取个人侧评估依据

- 从 user_profile 中抽取与方向取舍相关的事实：已有证据、偏好、现实约束如可投入时间、地域、期限等。
- 为每项依据记录出处标签（profile evidence）。
- 不读取或解释与方向无关的个人细节。

Success criteria:

- 得到 profile_evidence 列表、preference 列表、constraint 列表，每个条目能对应到 user_profile 的原始内容。

### 3. 逐方向评估四维信号

- 对每个候选方向分别计算 evidence_fit（个人证据与该方向的关联：直接/部分/无证据）、preference_fit（偏好匹配：高/中/低）、constraint_fit（约束适配：适配/部分适配/不适配）、uncertainty（信息不确定性：低/中/高）。
- 当某项无法判断时标记为 unknown 而不是猜测。
- 记录支撑每个信号的具体 user_profile 引用或 candidate_directions 自带来源字段。

Success criteria:

- 每个方向都有四个维度的评估值和依据说明；未知项被标记并进入不确定性汇总。

### 4. 计算贴合度排序并按规则分类

- 若提供 decision_weights，按权重加权；否则按默认等权。
- 将每个方向归入 retained、conditional 或 postponed：evidence_fit 为 direct 或 preference_fit 为 high 且 constraint_fit 为适配时优先 retained；evidence_fit 为 none 或 constraint_fit 为不适配时归 postponed；其余归 conditional。
- 在 retained 内先按加权分降序，再按信息不确定性升序；conditional 紧随其后；postponed 附原因。
- 若 decision_weights 为空，在输出中注明使用默认等权维度。

Success criteria:

- 得到有序的方向集合、每个方向的分类和可解释的排序理由。

### 5. 组装短名单并检查可追溯性

- 为每个保留方向写下一步验证建议（例如信息访谈、真实岗位检索、短期试做、证据补齐），建议必须对应其证据或不确定性缺口。
- 将最终结果整理为 prioritized_direction_shortlist 对象，包含 retained_directions、conditional_directions、postponed_directions、summary。
- 检查所有排序决定都能从输入维度反推，不能反推的降为 uncertainty 并在理由中说明。

Success criteria:

- 输出字段完整，排序决定可追溯，不确定性被显式表达。

## Decision rules

- 默认维度及权重：在 decision_weights 为空时，按 evidence_fit、preference_fit、constraint_fit 等权排序；uncertainty 只作次级排序。
- 分类判定：evidence_fit 为 direct 或 preference_fit 为 high 且 constraint_fit 为适配则为 retained；evidence_fit 为 none 或 constraint_fit 为不适配则为 postponed；其余为 conditional。
- 排序：retained 按加权贴合度降序，再按 uncertainty 升序；conditional 排在 retained 后；postponed 最后并附搁置原因。
- 冲突处理：user_profile 内证据相互冲突时保留两个证据并在 uncertainty 中说明，不自行判定哪个真实。
- 缺失处理：方向缺少来源或了解程度时不作猜测，直接提高 uncertainty 并在理由中说明。

## Outcome rules

### Success

- candidate_directions 是非空数组且每项可指认
- user_profile 可用
- 至少一个方向能给出四维评估或标记 unknown 并完成排序

### Insufficient input

- candidate_directions 缺失或为空
- candidate_directions 的项无法识别（无名称或无描述）
- user_profile 缺失

### Error

- 输入类型与 schema 不符（例如 candidate_directions 不是数组、user_profile 不是对象）
- 结果无法按本 Skill 规则生成（例如序列化失败）


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "prioritized_direction_shortlist": {
    "type": "object",
    "description": "保留或搁置的方向列表，每项给出贴合度、证据充分度、不确定性、取舍理由和下一步验证建议"
  }
}
```

Declared consumers:
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- candidate_directions 中的所有方向都出现在 retained、conditional 或 postponed 集合中，未新增方向。
- 每个保留方向的下一步验证建议都对应其 evidence_fit 或 uncertainty 缺口，而非泛泛而谈。
- decision_weights 为空时已在 summary 中声明使用默认等权维度。
- 所有个人事实判断都能回溯到 user_profile 或标记为 unknown，没有凭空假设。
- 输出中出现来源或证据引用时仅引用 user_profile 与 candidate_directions 自带字段。
