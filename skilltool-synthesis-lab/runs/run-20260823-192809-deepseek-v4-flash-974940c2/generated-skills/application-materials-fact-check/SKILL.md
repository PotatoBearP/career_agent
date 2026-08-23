---
name: application-materials-fact-check
description: "用户在准备投递时要求检查简历、求职信或项目描述里有没有编造、夸大或前后不一致的内容，例如“帮我校对一下这版材料有没有和事实不符的地方”或“帮我查一下材料里有没有夸大或前后矛盾的内容”。当用户没有提供任何可核验的申请材料文本，或目标岗位等外部信息与本次材料核验无关时，不应当调用本能力。本能力只做核验，不改写材料、不发送材料、不生成岗位要求分析。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 申请材料事实核验

子模型担任申请材料的事实核验员：只基于调用时已提供的 draft_materials、user_profile 和 evidence_gap_analysis 做一致性判断，不采访用户、不补采证据、不改写材料。

## Goal

逐条核对用户起草的申请材料中的经历、数字、职责和成果表述，对照已确认用户画像与已有证据判定为有证据支持、无证据支持、夸大或相互冲突，并输出包含问题位置、问题类型、事实依据和修改建议的核验报告。

## Hard boundary

- 不得新增、编造或推断任何 personal facts 作为已确认事实；所有基准事实必须来自 user_profile 或 evidence_gap_analysis 中明确列出的证据状态
- 不得修改、重写、压缩或美化 draft_materials 中的任何文档内容
- 不得调用 WebSearch、WebFetch、Read、Write、Edit 或其他工具来获取或补录证据；本能力使用已提供的输入
- 不得把 evidence_gap_analysis 中标记为缺少证据的能力改写成用户已经具备的能力
- 不得用占位符、示例或推测性语句填充报告；每条问题必须引用真实的材料文本位置和事实依据

In scope:

- 解析用户提供的申请材料文本（按文档名组织）并逐条抽取可核验的表述
- 从 user_profile 和 evidence_gap_analysis 中构建已确认事实与证据状态清单
- 将材料表述判定为 consistent、unsupported、exaggerated、contradictory 或 needs_confirmation
- 输出包含问题位置、问题类型、事实依据、证据来源与修改建议的核验报告
- 列出需要用户补充或确认的事实，保持不夸大边界

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `draft_materials` (object, required; source `user_input`, acquisition `request_user`): 用户起草的申请材料，按文档名组织，包含简历、求职信、项目描述等文本
- `user_profile` (object, required; source `upstream_artifact`, asset `user_profile`, acquisition `provided`): 已确认的用户画像，作为事实核验基准
- `evidence_gap_analysis` (object, required; source `upstream_artifact`, asset `evidence_gap_analysis`, acquisition `provided`): 经历与要求对照结果，用于判断哪些能力有证据、哪些仍待补充

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 加载并校验输入

- 读取 draft_materials 对象，遍历每个文档名称及其文本值；只保留非空字符串
- 读取 user_profile 中的已确认事实字段，包括教育、经历、项目、技能、成果与时间信息
- 读取 evidence_gap_analysis 中每个能力或经历的证据状态字段（如已有证据、证据不足、待补充）
- 若 draft_materials 为空对象、所有文档文本均为空，或 user_profile 与 evidence_gap_analysis 均缺失，判定为 insufficient_input

Success criteria:

- 已列出至少一份待核验材料文档
- 已建立名为 confirmed_facts 的已确认事实清单
- 已建立名为 evidence_status_map 的证据状态映射

### 2. 抽取材料断言

- 对每个文档逐段抽取可核验断言：数字与指标、时间与日期、机构与角色、技术或方法名称、职责描述、成果与完成度表述
- 为每条断言记录 document、location（章节或段落摘要）和 quote（原文摘录）
- 同一断言在多份文档中重复出现时，分别记录位置以支持冲突检测

Success criteria:

- 每条断言都有明确的文档归属和原文位置
- 断言列表已覆盖所有包含具体事实的句子

### 3. 逐条比对并分类

- 将每条断言与 confirmed_facts 和 evidence_status_map 进行比对
- 按 decision_rules 中的判定顺序给出唯一问题类型：consistent、unsupported、exaggerated、contradictory 或 needs_confirmation
- 对每条问题记录 evidence_basis：具体引用 user_profile 的哪个字段或 evidence_gap_analysis 中哪个证据状态的描述
- 保留所有矛盾：若同一事实在不同文档中表述不同，不自行取舍，逐条标记为 contradictory

Success criteria:

- 每条断言都有唯一的问题类型和 evidence_basis
- 所有跨文档不一致都被保留并标记

### 4. 生成核验报告

- 组装 report_items，每条包含 issue_location、issue_type、quoted_claim、evidence_basis、evidence_source、suggestion
- suggestion 只能建议用户删除、弱化、确认、补充事实或统一表述，不得直接给出替代文本并声称已改写
- 统计各类型条目数量，并列出 needs_user_supplement 事实清单
- 若全部断言为 consistent，输出总体状态 verified；否则输出总体状态 issues_found

Success criteria:

- 报告对象包含 summary、report_items、needs_user_supplement 字段
- 每条 report_item 都包含位置、类型、原文、依据、来源与建议

## Decision rules

- 判定顺序固定为：先检查矛盾（contradictory），再检查无证据（unsupported），再检查夸大（exaggerated），否则有直接证据则 consistent，无法判定且证据状态为待补充则 needs_confirmation
- 断言中的数字、日期、角色、机构或结果若与 user_profile 直接冲突，判定为 contradictory
- 断言中的数字、指标或公开成果在 user_profile 与 evidence_gap_analysis 中均无任何对应依据，判定为 unsupported，并建议用户确认或删除
- 断言表述明显超出 evidence_gap_analysis 中所记录的证据强度，例如证据状态为待补充却写成已完成并给出量化结果，判定为 exaggerated
- 断言涉及的事实未出现在已确认事实中，但 evidence_gap_analysis 标记其处于待补充状态且断言并无夸大措辞，判定为 needs_confirmation
- 证据来源优先级：user_profile 已确认字段 > evidence_gap_analysis 中已有证据条目 > draft_materials 自身表述（最低，不可作为自身的证据依据）

## Outcome rules

### Success

- draft_materials 中至少有一份非空材料文本
- 已生成包含 summary、report_items、needs_user_supplement 的完整核验报告，即使全部断言均 consistent 也属于 success

### Insufficient input

- draft_materials 为空对象或所有文档文本均为空
- user_profile 与 evidence_gap_analysis 均未提供，导致无法建立任何事实基准
- 材料文本存在但全部为不可解析的无事实性内容

### Error

- 输入对象结构被破坏导致无法枚举文档（如非对象值）且调用方未提供可解析文本
- 执行结果无法序列化为所声明的 fact_check_report 对象结构


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "fact_check_report": {
    "type": "object",
    "description": "逐条核验结果，包含问题位置、问题类型、事实依据和修改建议"
  }
}
```

Declared consumers:
- task_revise_materials_with_fact_check_results
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- fact_check_report.summary 中存在材料总数、问题总数与总体状态
- 每个 report_item 都有非空的 issue_location、issue_type、quoted_claim、evidence_basis、suggestion
- 所有 evidence_basis 均明确来自 user_profile 或 evidence_gap_analysis，没有新增外部事实
- 报告未包含任何被改写后的材料文本，也没有任何越权建议向外部发送材料
- 仅调用一次 ReturnSkillResult，不使用任何普通工具
