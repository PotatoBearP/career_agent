---
name: evidence-gap-plan
description: "当用户已经拥有真实机会清单，并希望把自己的真实经历和材料与这些机会的要求逐项对照，从而知道每项要求差多少、用什么真实证据补足时使用。不用于重新研究岗位要求、不用于重做机会核验、不用于生成联系消息或投递材料，也不用于修改用户画像或投递材料。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 岗位要求差距与能力证据规划

证据差距审计员：只审计输入中已经存在的真实证据，对照机会要求判定差距，并把差距转成可执行的补充证据建议。

## Goal

对照用户已确认的真实机会清单，逐条评估用户现有真实证据的满足程度，给出差距等级、可采集或可表达的补充证据建议，并保留来源、依据和下一步动作，供联系和申请中使用。

## Hard boundary

- 冻结证据边界：只使用 user_profile、material_quality_report、user_evidence_input 中已提供的内容，不调用 Web、不读取额外文件、不向用户询问更多输入。
- 不得修改或重写 user_profile、verified_opportunity_list、material_quality_report 等上游产物，只读取其字段。
- 不得编造经历、成果、评价、推荐、共同经历或任何证据；每条已用证据必须能引用到上述输入中的原始内容。
- 不得把 opportunity 级别的推测当成 requirement 事实；要求只能来自 verified_opportunity_list。
- 不得把本能力扩展成完整求职计划或联系消息生成；只输出证据差距与补充证据建议。

In scope:

- 从 user_profile、user_evidence_input、material_quality_report 中提取可核验的真实证据
- 将 verified_opportunity_list 中的每个机会拆成 requirement_id 级要求条目
- 把真实证据逐项映射到机会要求并判定差距等级
- 为部分差距和完全缺失给出可采集或可表达的 evidence_action 与表达建议
- 对输出按机会和差距等级去重、排序并保留证据来源

The scenario alone defines the domain (`explicit`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `user_profile` (object, required; source `upstream_artifact`, asset `user_profile`, acquisition `provided`): 用户已有的画像信息，包含真实经历和能力证据
- `verified_opportunity_list` (array, required; source `upstream_artifact`, asset `verified_opportunity_list`, acquisition `provided`): 用户已经确认的真实机会清单，作为要求对照的目标
- `material_quality_report` (object, required; source `upstream_artifact`, asset `material_quality_report`, acquisition `provided`): 用户已有投递材料的质量检查结果，用于判断哪些材料可以作为现有证据
- `user_evidence_input` (object, required; source `user_input`, acquisition `request_user`): 用户愿意提供的额外真实经历、课程、项目、成果、评价或其他证明材料

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 建立证据清单

- 从 user_profile 中提取可核验的经历、项目、成果、能力句，并为每条生成 evidence_ref。
- 从 material_quality_report 中读取材料质量结论，标记哪些材料被确认可用、哪些被标记为薄弱或缺失。
- 把 user_evidence_input 中用户明确提供的额外真实证据并入证据清单；空对象时跳过。
- 为每项证据保留来源，区分事实本身与检查报告给出的判断。

Success criteria:

- 证据清单中每项都有唯一 evidence_ref 和来源
- material_quality_report 的薄弱结论被作为材料级证据保留，而不是被丢弃
- 没有把未提供的信息加入证据清单

### 2. 建立要求清单

- 遍历 verified_opportunity_list，为每个机会的每条要求生成 opportunity_id、requirement_id、requirement_text。
- 若要求文本标有 required/必须/要求，标记 required_or_preferred=required；标有 preferred/优先/加分，标记 preferred；无法判定时标记 unspecified。
- 保持要求原文含义，不合并、不重写、不补写机会中不存在的要求。

Success criteria:

- 每个机会至少提取到一条要求，或可明确说明无法提取要求
- requirement_id 在同一机会内唯一
- 要求文本与 verified_opportunity_list 中的原文语义一致

### 3. 证据到要求的映射

- 对每条 requirement，逐项判断证据清单中哪些 evidence_ref 真正支持该要求。
- 只承认能直接展示对应经历、成果或能力的证据；泛泛的课程名称或自我评价在无支撑时不能算直接满足。
- 遇到互相矛盾或来源不可核验的证据时，在记录中保留冲突而不自行消除。

Success criteria:

- 每条 requirement 都有 matched_evidence_refs 列表，可为空
- 映射依据可追溯到具体 evidence_ref
- 冲突证据被记录，而不是被隐藏

### 4. 判定差距与补充证据建议

- 按决定规则计算每条要求的 gap_level。
- 为 partial 和 gap 条目给出 evidence_actions：优先排在现有材料中补强表述，其次是通过真实项目、信息访谈或实习等可验证渠道采集证据，最后是补充与该要求更直接的真实记录。
- 为每条给出 expression_suggestion，只建议如何如实说明已有证据，不教用户夸大或包装不存在的经历。

Success criteria:

- 每条 requirement 都有一个 gap_level 和对应的 evidence_actions
- evidence_actions 不要求用户伪造经历，也不要求调用外部检索
- expression_suggestion 与 evidence_actions 一致

### 5. 组装并校验证据差距与补充清单

- 按 opportunity_id 保留 verified_opportunity_list 的原始顺序；同一机会内按 gap、partial、unknown、sufficient 排序。
- 用 opportunity_id|requirement_id|gap_level|evidence_action 语义去重，避免同一要求重复记录。
- 检查所有 matched_evidence_refs 都能在证据清单中找到，所有输出字段完整。

Success criteria:

- evidence_gap_analysis 为非空数组并且每条记录结构完整
- 去重后没有重复的 requirement 记录
- 每条记录都有 basis 说明判断依据

## Decision rules

- 要求性质判定：含 required/必须/要求视为 required；含 preferred/优先/加分视为 preferred；无法判定视为 unspecified 并按 required 保守处理。
- gap_level 判定：直接且可核验的证据完全覆盖要求=suffcient；有相关但非直接证据（如课程项目对生产经验要求）=partial；没有任何可映射证据=gap；证据互相矛盾或来源不可核验=unknown。
- 证据冲突处理：当 user_profile 与 material_quality_report 或 user_evidence_input 冲突时，取更能直接证明该要求的证据作为主体，并在 basis 中保留冲突说明。
- evidence_action 排序：能靠调整现有材料表达解决的排最前，需要真实采集新证据的排其后；不得把‘学习计划’或‘时间表’写成证据动作。
- 输出范围：每个 opportunity_id 只描述该机会自己的要求，禁止把不同机会的要求合并或复用。

## Outcome rules

### Success

- verified_opportunity_list 中存在至少一个机会且至少一条可识别的要求
- 证据清单、要求清单与映射均已完成
- evidence_gap_analysis 非空且每条记录结构完整、来源可追溯

### Insufficient input

- verified_opportunity_list 为空、缺失或没有任何要求文本
- user_profile 与 user_evidence_input 都缺失有效证据，无法做任何对照
- material_quality_report 缺失，导致无法区分材料可用与材料薄弱

### Error

- 输入类型与 input_schema 声明不一致，如 verified_opportunity_list 不是数组
- 序列化或内部处理失败导致无法形成结构化输出


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "evidence_gap_analysis": {
    "type": "array",
    "description": "按机会和分析维度列出的差距等级、已有证据、可补充证据和表达建议"
  }
}
```

Declared consumers:
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- 检查 evidence_gap_analysis 中每条记录都含有 opportunity_id、requirement_id、gap_level、evidence_action 与 basis。
- 检查所有 gap_level 都来自允许的枚举集：sufficient、partial、gap、unknown。
- 检查 matched_evidence_refs 中的每个引用都存在于本调用建立的证据清单之中。
- 检查没有出现用户未提供的经历、成果或背书表述。
- 检查没有改写或重新生成 user_profile、verified_opportunity_list、material_quality_report。
