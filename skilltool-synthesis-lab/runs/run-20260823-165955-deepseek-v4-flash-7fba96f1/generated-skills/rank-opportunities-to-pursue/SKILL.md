---
name: rank-opportunities-to-pursue
description: "用户已经拥有一份已核验的真实岗位机会清单，并希望结合自身情况和偏好确定优先投递或联系顺序时使用。不用于岗位检索、岗位有效性核验、组织可信度评估、投递材料撰写或职业方向推荐。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 帮我排一下这些岗位先投哪些

证据与排序裁判：只依据输入的机会清单、用户画像、排序偏好和已有的证据对照结果，生成可解释的优先顺序；不检索新信息，不修改输入，不对市场或岗位状态作新假设。

## Goal

根据已核验的真实岗位机会清单，结合用户画像中的证据与偏好以及用户本次给出的排序因素，排出先联系、后联系和暂缓的顺序，并为每个机会说明排序理由、与用户证据的匹配点、不确定性和需要先核实的事项。

## Hard boundary

- 禁止调用 WebSearch、WebFetch、文件系统、内部服务或任何外部数据源；只使用输入字段。
- 禁止重新核验或改变岗位的有效性、发布状态、组织可信度等输入中已记载的状态。
- 禁止臆造用户的地区、时间预算、偏好、证据或岗位要求；超出输入证据的匹配判断必须标记为未知。
- 禁止对某个岗位给出“必然适合/必然不适合”的结论，只呈现证据支持的匹配点、不确定性和待核实项。
- 创建输出后只调用一次 ReturnSkillResult，并不要在 result 之后追加额外建议或行动指南。

In scope:

- 对输入的机会清单做加权排序
- 按先联系、后联系、暂缓给出档位
- 逐项解释排序理由、证据匹配点、不确定性与待核实事项
- 保持输入中岗位字段的原始来源与核验状态

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `verified_opportunity_list` (array, required; source `prior_skill_output`, asset `verified_opportunity_list`, acquisition `prior_skill`): 已核验的真实岗位机会清单，作为待排序的候选机会
- `user_profile` (object, required; source `upstream_artifact`, asset `user_profile`, acquisition `provided`): 用户画像中的证据、偏好与现实约束，用于判断各岗位的贴合度与优先级
- `ranking_preferences` (object, required; source `user_input`, acquisition `request_user`): 用户关心的排序因素，如地理位置、组织类型、机会类型、时间紧迫性和准备成本
- `evidence_gap_analysis` (object, required; source `prior_skill_output`, asset `evidence_gap_analysis`, acquisition `prior_skill`): 已有经历与目标方向要求的对照结果，作为排序时的匹配度补充参考；没有时忽略

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 验证输入完整性与类型

- 确认 verified_opportunity_list 必须存在、类型为 array 且非空；否则进入 insufficient_input。
- 确认 user_profile 必须存在且为 object，能从其中读取证据、偏好与约束。
- 确认 ranking_preferences 必须存在且为 object，并至少含一个可用于排序的因素。
- 若有 evidence_gap_analysis，必须是 object；缺失或不可用则按可选输入处理。

Success criteria:

- 四项输入均通过类型检查，或明确判定缺失项属于 insufficient_input。

### 2. 抽取排序依据

- 从 ranking_preferences 读取目标地区、组织类型、机会类型、时间紧迫性、准备成本及相对权重；无权重则后续均等加权。
- 从 user_profile 读取用户已有证据、偏好和现实约束。
- 若 evidence_gap_analysis 存在，读取其中逐项匹配状态、证据缺口和待验证项。
- 为每个机会建立字段索引，确保后续可引用机会标识、组织、地点、发布时间、核验状态等字段。

Success criteria:

- 得到明确的排序维度集合，且每个维度都能映射到输入字段。

### 3. 逐机会评分

- 对每个机会按维度计算 1-3 分：偏好贴合度（地区、组织类型、机会类型是否匹配 ranking_preferences）、证据匹配度（存在 evidence_gap_analysis 时按直接证据/部分证据/缺口取值；缺失时保守记为未知）、时机与准备成本（发布时间新旧、输入中的核验状态、用户所述准备成本）。
- 按 ranking_preferences 中的权重对维度分加权汇总；无权重时各维度均等。
- 为每个机会记录总分、分维度得分和置信度（高/中/低）。

Success criteria:

- 每个机会都有可回溯的维度分、总分和置信度；任何未知维度都被明确标记，而不是被当成确定值。

### 4. 排序并划分档位

- 按总分降序排列全部机会。
- 按阈值归类：总分不低于高阈值记为先联系，处于中阈值区间记为后联系，低于低阈值记为暂缓；阈值需在输出中说明。
- 同分时优先排列证据匹配分更高者；仍同分则优先排列发布时间更新者；仍同分则保持输入顺序。

Success criteria:

- 输出一个确定且无歧义的有序列表，每个机会有唯一顺序位和档位标签。

### 5. 生成逐项说明

- 对每个机会生成建议顺序、排序理由、与用户证据的匹配点、不确定性和需要先核实的事项。
- 排序理由必须引用具体输入字段，如偏好中的地区/组织类型、画像中的证据项、对照结果中的匹配状态、输入中的发布时间或核验状态。
- 不确定性只能来自输入中已标出的缺口、未知状态或缺失的 evidence_gap_analysis。
- 需要先核实的事项只能列出输入已暴露的待确认项（如状态未知、证据缺失、信息不一致），不得新增检索任务。

Success criteria:

- 每个机会的五项说明均存在，且全部内容都能回溯到输入字段。

### 6. 组装输出并调用 ReturnSkillResult

- 组装 opportunity_pursuit_ranking 对象，包含排序依据说明、档位阈值、有序机会列表和逐项说明。
- 执行最终检查列表中的所有断言。
- 调用一次 ReturnSkillResult 返回结果。

Success criteria:

- 输出通过最终检查，且只调用一次 ReturnSkillResult。

## Decision rules

- 评分标尺固定为 1-3：偏好贴合维度按匹配排序因素计分；证据匹配维度在 evidence_gap_analysis 存在时按 direct evidence=3、partial evidence=2、gap/no evidence=1 计分，缺失该输入时一律记录为 unknown 且该维度不参与总分权重之外的惩罚。
- 无权重时各排序维度均等加权；有权重时按 ranking_preferences.weights 归一化后加权。
- 时机维度：输入中核验状态为有效或发布时间较新时给更高分；状态为未知/未标注时给中值并标记 low confidence。
- 档位划分默认：总分 >= 2.5 为先联系，1.5 至 2.4 为后联系，< 1.5 为暂缓；若用户偏好导致阈值调整，需在排序依据说明中写明。
- 排序偏好与用户画像中的既有偏好冲突时，以本次 ranking_preferences 为准，并在该机会的排序理由中注明两个来源的差异。

## Outcome rules

### Success

- 机会清单非空，且已完成排序并划分档位。
- 输出中包含排序依据、档位阈值、每个机会的建议顺序、排序理由、证据匹配点、不确定性和待核实事项。
- 输出中的每个条目均引用输入机会清单中的对应标识。

### Insufficient input

- verified_opportunity_list 缺失或为空数组。
- ranking_preferences 缺失或无法解析出任何排序因素。
- user_profile 缺失或不是可用对象。
- evidence_gap_analysis 被提供但类型错误且无法作为可选参考使用。

### Error

- 输入结构无法解析（例如非 JSON 对象或字段类型不可读）。
- 排序过程中出现无法映射到输入机会标识的条目。
- 输出序列化失败或无法组装 opportunity_pursuit_ranking 对象。


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "opportunity_pursuit_ranking": {
    "type": "object",
    "description": "排序后的机会列表，每项给出建议顺序、排序理由、与用户证据的匹配点、不确定性和需要先核实的事项"
  }
}
```

Declared consumers:
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- 输出中的每个排序条目都能在 verified_opportunity_list 中找到对应机会标识。
- 每条排序理由至少引用一个具体输入字段，例如偏好值、证据项、发布时间或核验状态。
- 每个条目均包含不确定性和待核实事项，且这些内容没有超出输入证据边界。
- 没有对岗位有效性、组织可信度或市场行情作出输入中不存在的断言。
- 只调用一次 ReturnSkillResult，且 result 后没有追加建议。
