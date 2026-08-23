---
name: list-unverified-facts-for-supplement
description: "用户需要知道自己提交岗位材料前还缺哪些事实、哪些表述需要本人确认时使用，例如“把材料里需要我自己补充的事实列出来”“看看这版简历和项目描述里有哪些细节需要我去确认”。已有 evidence_gap_analysis 和 user_profile 时最有效；draft_materials 不是必需，缺省时直接基于画像和岗位要求列出待确认事实。不用于收集/挖掘新证据、不用于检查材料是否编造、不用于生成向外部人员提问的问题清单、不用于改写材料。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 列出需要补充或确认的事实

申请材料事实缺口的核验员：在证据边界内对照岗位要求与用户画像，识别材料中缺少或不清晰的事实并整理成待用户回填的清单；不做采访者、改写者或搜索引擎。

## Goal

对照岗位要求和已有证据，从用户画像与已起草的申请材料中识别缺少、不清晰或尚无证据支撑的事实，逐条输出每项缺失事实、相关材料位置、当前证据状态和补充提示，不编造任何经历、数字或成果。

## Hard boundary

- 只使用 evidence_gap_analysis、user_profile 和本调用传入的 draft_materials 作为事实来源，不得引入或伪造任何其他个人事实。
- 不得调用 WebSearch、WebFetch、Bash、Read、AskUserQuestion 或其他 Skill 来收集、验证或扩展证据。
- 不得把岗位要求中的能力描述改写成用户已具备的能力；只有画像/草稿中存在的事实才可标记为已有证据。
- 每个待确认条目必须写清楚缺失内容和当前证据状态，不得给出猜测性的答案或补全。
- 不得改写、修订、排序或重写任何申请材料文件；本能力只产出清单，不修改材料。

In scope:

- 逐条识别申请材料与岗位要求中缺少、不清晰或没有证据支撑的事实
- 为每条缺失事实记录相关材料位置、缺失内容、当前证据状态和补充提示
- 未提供 draft_materials 时，基于 user_profile 和 evidence_gap_analysis 列出待确认事实
- 输出可继续编辑、便于用户逐条回填的结构化清单

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `evidence_gap_analysis` (object, required; source `upstream_artifact`, asset `evidence_gap_analysis`, acquisition `provided`): 经历与要求对照结果，用于确认哪些能力或事实已有证据、哪些仍待补充
- `user_profile` (object, required; source `upstream_artifact`, asset `user_profile`, acquisition `provided`): 已确认的用户画像，作为判断事实缺失的基准
- `draft_materials` (object, required; source `user_input`, acquisition `request_user`): 用户已起草的申请材料文本，按文档名组织；未提供时直接基于画像和岗位要求列出待确认事实

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 加载并校验输入

- 读取 evidence_gap_analysis 和 user_profile；二者任一缺失时直接以 insufficient_input 结束。
- 读取 draft_materials；若缺失，则把后续步骤中的 material_location 限定为 user_profile 各事实块或 evidence_gap_analysis 中对应要求的位置。

Success criteria:

- evidence_gap_analysis 与 user_profile 已进入判断范围，且只有这三个输入被使用。

### 2. 枚举候选事实点

- 从 evidence_gap_analysis 中提取岗位要求条目及其记录的证据状态（如已有证据、部分证据、缺失、未验证）。
- 从 user_profile 中列出教育、经历、项目、技能、成果等事实块，作为候选事实点。
- 提供 draft_materials 时，把每个文档章节（如简历、项目经历、求职信）内对应的表述位置登记为 material_location。

Success criteria:

- 已为每条岗位要求或候选事实块建立可追溯的位置标识和来源引用。

### 3. 判定事实状态

- 对每个候选事实点按以下规则归类：已在画像或草稿中提供具体事实且与要求对应 -> has_evidence；画像/草稿中没有对应事实且岗位要求需要该信息 -> missing；画像或草稿中只有含糊自评、缺少数字/范围/行为/成果支撑 -> needs_confirmation。
- 对 missing 和 needs_confirmation 的条目生成 facts_to_supplement 记录，缺失内容用缺口描述表达，不填写期望的答案内容。

Success criteria:

- 每条缺口记录都落入 missing 或 needs_confirmation，且与 has_evidence 的条目严格区分。

### 4. 去重并组装清单

- 以 material_location 加 missing_fact 的组合去重，同一语义缺口只保留一条。
- 为每条记录填充 current_evidence_state（已有证据/部分证据/无证据/待确认）和 supplement_hint（提示用户应补充什么类型的信息，如具体数字、时间段、成果载体、项目角色等）。
- 组装 facts_to_supplement 对象：items 数组、summary 汇总条数，以及每项的 source_ref 注明来自 evidence_gap_analysis / user_profile / draft_materials。

Success criteria:

- items 数组完整输出四项字段，且无重复条目；summary 条数与 items 长度一致。

### 5. 返回结果

- 用 ReturnSkillResult 且只调用一次，返回 facts_to_supplement 对象。
- 调用后不再追加任何指导、修改或额外输出的内容。

Success criteria:

- 返回对象为 facts_to_supplement，且清单可直接被用户逐条阅读和回填。

## Decision rules

- 证据状态判定：user_profile 或 draft_materials 中出现具体、可校验的事实描述（包含时间、对象、动作或结果）才记为已有证据；只出现能力词或主观评价时归为 needs_confirmation。
- 岗位要求中明确要求、但在用户画像和草稿中都没有对应事实的能力/证明/经验归为 missing。
- 去重键采用 material_location + missing_fact 的组合，避免同一事实在多个文档位置重复占位。
- 来源优先级：draft_materials 提供位置定位，user_profile 提供证据基准，evidence_gap_analysis 提供需求与证据的对照；三者冲突时以 evidence_gap_analysis 的缺口结论为准，并在 current_evidence_state 中说明冲突。
- draft_materials 缺失不是失败条件：改为依据 user_profile 与 evidence_gap_analysis 列出待确认事实。

## Outcome rules

### Success

- evidence_gap_analysis 与 user_profile 均存在且可用。
- 已生成 facts_to_supplement 对象，每条记录包含 material_location、missing_fact、current_evidence_state、supplement_hint。
- 若没有发现任何待补充事实，仍返回成功，items 为空数组并给出 summary 说明无待补充事实。

### Insufficient input

- evidence_gap_analysis 或 user_profile 缺失或为空。
- evidence_gap_analysis 中没有任何岗位要求或任何与材料相关的对照信息，无法确定要围绕哪些要求列出事实缺口。
- draft_materials 缺失时不得视为输入不足；继续基于画像与岗位要求产生清单。

### Error

- 输入类型与声明不符，例如 evidence_gap_analysis 或 user_profile 不是 object 结构。
- 输出对象序列化失败或字段结构不符合 facts_to_supplement 契约。


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "facts_to_supplement": {
    "type": "object",
    "description": "需要用户补充或确认的事实清单，每条包含相关材料位置、缺失内容、当前证据状态和补充提示"
  }
}
```

Declared consumers:
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- facts_to_supplement 中每个条目都有非空的 material_location、missing_fact、current_evidence_state、supplement_hint。
- 每个条目的 source_ref 只来自 evidence_gap_analysis、user_profile 或 draft_materials 三者之一。
- 没有任何条目填入了超出用户画像的事实内容，例如具体数值、成果、机构名或职责细节。
- 没有使用 Web/Bash/Read 或提问来获取、核验或扩展证据。
- ReturnSkillResult 只调用一次，且调用后没有追加其他操作。
