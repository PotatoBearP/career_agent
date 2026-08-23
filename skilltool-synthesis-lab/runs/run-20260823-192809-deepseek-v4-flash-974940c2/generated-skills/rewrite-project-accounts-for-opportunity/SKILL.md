---
name: rewrite-project-accounts-for-opportunity
description: "当用户提供一组项目经历条目、目标岗位要求，以及已有的经历与要求对照结果（evidence_gap_analysis）和用户画像（user_profile），并要求把这些项目经历改写成对应岗位可用的描述时使用。已有普通工具或官方材料处理过的岗位事实不得在此重复核查。不要用于生成简历整体、撰写求职信、判断岗位匹配度或评估用户能力。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 按岗位要求改写项目经历

项目经历改写者：只负责把输入中的项目条目重新组织为与目标岗位要求对应的表述，并充当事实边界审核者，凡是证据不足的事实一律标注，不得代用户确认或补写。

## Goal

针对目标岗位的职责与要求关键词，把用户的项目经历逐条改写成招聘方能快速看出对应关系的描述，同时标记哪些事实有证据支撑、哪些属于不可改动或需要用户补充的事实边界。

## Hard boundary

- 只处理本次调用输入中的 project_entries；绝不从 evidence_gap_analysis、user_profile 或岗位要求之外添加任何经历、数字、职责或成果。
- 不重新生成或修改 evidence_gap_analysis、user_profile、target_opportunity；这三个输入只作为核对与比对基准，禁止写入或改写。
- 不得把岗位要求改写成用户已经具备的能力；岗位要求中的技能若在证据中不存在，必须在 fact_boundary_notes 中标为待确认。
- 不调用任何外部工具、不检索网络、不读取本地文件；只基于 project_entries、target_opportunity、evidence_gap_analysis、user_profile 完成改写。
- 改写只能改变表述重点、语序和用词，不得改变原事实的语义、程度或归属；凡需要调整事实范围的改动一律拒绝并标注。

In scope:

- 把用户提供的每个项目条目按目标岗位要求关键词重新组织动作、结果和技能表述
- 标注每条改写所对应的岗位关键词
- 用 evidence_gap_analysis 与 user_profile 核对事实边界，列出不可改写的事实
- 输出需要用户补充或确认的事实清单

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `project_entries` (array, required; source `user_input`, acquisition `request_user`): 用户提供的项目经历条目，每条包含项目名称、承担角色、事实性动作、结果和相关技能
- `target_opportunity` (object, required; source `user_input`, acquisition `request_user`): 目标岗位的职责、要求关键词和招聘方关注点
- `evidence_gap_analysis` (object, required; source `upstream_artifact`, asset `evidence_gap_analysis`, acquisition `provided`): 经历与要求对照结果，用于识别哪些项目事实已经是可靠证据
- `user_profile` (object, required; source `upstream_artifact`, asset `user_profile`, acquisition `provided`): 已确认的用户画像，用于核对项目事实和技能表述

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 装载并校验输入

- 读取 project_entries，确认其为非空数组且每条至少包含项目名称、承担角色和事实性动作。
- 读取 target_opportunity，确认其中能解析出职责或要求关键词；无法解析则返回 insufficient_input。
- 读取 evidence_gap_analysis 与 user_profile，确认二者作为事实基准可用；任一缺失且无法从其余输入推断时返回 insufficient_input。

Success criteria:

- 四类输入均已确认存在且类型可用
- 已能从 target_opportunity 提取出至少一组要求关键词或职责

### 2. 建立岗位要求索引并映射证据

- 从 target_opportunity 抽取要求关键词、职责和招聘方关注点，整理为 requirement_index。
- 从 evidence_gap_analysis 读取每个项目事实的证据状态（可靠证据 / 缺口 / 待确认）。
- 把每个 project_entry 的动作、结果、技能与 requirement_index 中的关键词逐一建立候选映射；只保留有事实依据的映射。

Success criteria:

- requirement_index 已生成
- 每个项目条目至少完成一次证据状态归类
- 所有候选映射都来源于输入字段，没有自创关键词

### 3. 逐条改写并守证据边界

- 对每个 project_entry，先锁定 original_facts（名称、角色、事实性动作、结果、技能）。
- 针对命中的要求关键词重写描述：突出与岗位相关的动作与结果、调整语序、使用招聘方可快速识别的表达。
- 凡某个结果或技能在 evidence_gap_analysis 或 user_profile 中没有证据支撑，不得写入改写后的结果句；改写成仅描述已动作或标记 requires_user_confirmation=true。

Success criteria:

- 每个 entry 都有 rewritten_description 且可追溯到原 project_entry
- 无证据的数字、职责或成果未被写入任意 rewritten_description
- 每个 entry 都填写 matched_opportunity_keywords、unchanged_facts、fact_boundary_notes

### 4. 整理补充事实并按输出契约返回

- 汇总所有 requires_user_confirmation=true 的条目，生成 fact_supplement_requests 列表，每条说明相关材料位置、缺失内容、当前证据状态和补充提示。
- 按输出契约组装 rewritten_project_descriptions 对象，写入 entries、fact_supplement_requests 与 source_provenance。
- 检查字段名、类型与完整性后，调用 ReturnSkillResult 一次并返回单个结果对象。

Success criteria:

- 输出对象包含 entries、fact_supplement_requests、source_provenance
- fact_supplement_requests 与各 entry 的 fact_boundary_notes 一致
- ReturnSkillResult 只调用一次且携带调用信封中的 skill_call_id 与 skill_name

## Decision rules

- 映射排序：优先把 evidence_gap_analysis 中确认为可靠证据且与岗位关键词直接相关的动作、结果放在每条描述最前；缺口或待确认项只能放在陈述之后并用事实边界标注。
- 语态判定：动作有证据支持时用主动语态（完成了、设计了、实现了）；仅部分证据时用保守表达（参与了、完成了部分）；完全无证据时只描述项目本身背景，不得断言个人贡献。
- 事实冲突：改写后的表述若与 evidence_gap_analysis 中标记为缺口的内容冲突，以缺口状态为准，降级表述并置为 requires_user_confirmation。
- 结果数字规则：任何数量、指标或成果数字只能出现在 user_profile 或 evidence_gap_analysis 已确认的证据中；其他一律记入 fact_boundary_notes 并加入 fact_supplement_requests，禁止估算或推断。
- 低相关条目：某项目条目无法对应任何岗位关键词时，保留其原始事实表达并在 fact_boundary_notes 注明与目标岗位相关性低，不强行改写。

## Outcome rules

### Success

- project_entries 为非空数组且每条可解析
- target_opportunity 可解析出职责或要求关键词
- 至少一个项目条目完成改写并以对象形式返回
- 所有无证据内容均已降级表述或标记 requires_user_confirmation

### Insufficient input

- project_entries 缺失、为空或不是数组
- target_opportunity 缺少职责与要求关键词，无法建立映射基准
- evidence_gap_analysis 或 user_profile 缺失，且无法确认真实事实边界

### Error

- 任一输入字段类型与契约不符且无法解析
- 改写请求要求编造数字、结果或职责（例如“把没有的指标写上”）
- 输出序列化失败或未能在一次 ReturnSkillResult 内返回结果对象


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "rewritten_project_descriptions": {
    "type": "object",
    "description": "逐条改写后的项目描述，包含原事实、改写后表述、对应岗位关键词和不可改写的事实边界"
  }
}
```

Declared consumers:
- task_prepare_project_showcase_sheet
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- 每个 rewritten_description 都能对应到输入中的一个原始 entry 及其项目名称和角色，未新增任何无证据事实。
- matched_opportunity_keywords 均来自 target_opportunity 的原始文本，未自创关键词。
- fact_boundary_notes 与 fact_supplement_requests 覆盖所有 evidence_gap_analysis 中标为缺口且与目标岗位相关的事实。
- 输出字段名与类型严格符合 rewritten_project_descriptions 契约：entries 为 array，fact_supplement_requests 为 array，source_provenance 为 object。
- 整个执行未调用任何子工具、外部网络或文件系统。
- ReturnSkillResult 已恰好调用一次。
