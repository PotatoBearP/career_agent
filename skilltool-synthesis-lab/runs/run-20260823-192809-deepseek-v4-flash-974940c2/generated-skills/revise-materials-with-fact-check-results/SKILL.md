---
name: revise-materials-with-fact-check-results
description: "用户已经拿到一份材料事实核验报告，并明确要求把核验发现的问题直接改掉、出一版修订稿时使用；不应在缺少核验报告、用户只要求重新检查材料，或用户只要求审查而非修改时使用。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 按检查结果修订材料

事实边界受限的材料修订编辑：把核验报告的结论逐条落到具体文档片段上，不引入任何报告与画像之外的新事实。

## Goal

把材料事实核验报告中的每条问题逐项落到待修订材料上，产出一版事实边界清晰的修订稿和逐条修改说明，供用户直接继续编辑或提交。

## Hard boundary

- 冻结证据边界：只使用 fact_check_report、draft_materials 和 user_profile 三个输入，不调用 Web、不读取其他文件或 Skill，不向用户补充提问后再重跑核验
- 每一次文本改动必须能追溯到 fact_check_report 中的一条问题；不得顺带改写报告未指出的内容
- 不得为修复被标记的问题而编造或推断新的经历、数字、职责、成果或技能
- 不得重新生成核验报告、缺口报告或任何新的诊断类产出
- 不得代替用户发送、提交或导出材料；所有输出先交回用户核对

In scope:

- 逐条解析 fact_check_report 中的问题位置、问题类型、事实依据和修改建议
- 只修改核验报告指向的文本片段，并保持未涉及内容不变
- 对照 user_profile 与核验报告的事实依据完成修订
- 输出 revised_materials 对象，包含修订后文本和每条修改的原因说明
- 对缺少证据、无法安全定稿的问题标记为待用户确认，不擅自补全

The scenario alone defines the domain (`explicit`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `fact_check_report` (object, required; source `prior_skill_output`, asset `fact_check_report`, acquisition `prior_skill`): 材料事实核验报告，包含问题位置、问题类型、事实依据和修改建议
- `draft_materials` (object, required; source `user_input`, acquisition `request_user`): 用户提供的待修订申请材料，按文档名组织，包含简历、求职信和项目描述文本
- `user_profile` (object, required; source `upstream_artifact`, asset `user_profile`, acquisition `provided`): 已确认的用户画像，用于在修订时保持所有表述在事实范围内

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 校验输入并建立问题清单

- 确认 fact_check_report 是包含问题条目的对象，且每条包含定位信息（文档名或段落位置）、问题类型、事实依据和修改建议
- 确认 draft_materials 是非空对象，且 fact_check_report 引用到的文档名能在 draft_materials 中找到
- 确认 user_profile 已提供，用于判断事实边界
- 把 report 的问题逐条列为 operation 清单，并为每条绑定 target_document

Success criteria:

- 每条问题都能定位到 draft_materials 中的具体文档，或已明确标记为无法定位
- 无法定位时按 insufficient_input 处理，不猜测目标位置

### 2. 为每条问题确定事实裁决

- 对每条问题，取出 user_profile 与核验报告中的事实依据，判断该问题属于：无证据支撑、与画像冲突、夸大表述、表述不清晰或前后不一致
- 若画像或报告依据能给出正确事实，则记录替换文本
- 若找不到可信的替换事实，则判定为 pending_confirmation：删除该表述、保留原文并标注待确认，或留空请用户补充，绝不自创答案

Success criteria:

- 每条问题都被归入可修订或待用户确认两类之一
- 待确认条目明确写出缺失事实是什么，而非给出猜测文本

### 3. 逐文档应用修订

- 对 draft_materials 的每个文档创建 revised_text 副本
- 只替换 fact_check_report 指向的片段：应用已裁决的替换文本，或删除无证据表述，或插入待确认占位说明
- 保持文档原有结构、语言、节序和未涉及内容不变
- 为每个改动生成 change 记录：原片段、新片段、对应问题、原因、事实依据、状态（applied 或 pending_confirmation）

Success criteria:

- 所有被修改的片段都能对应到一条问题
- 所有 applied 改动的事实依据来自 user_profile 或 fact_check_report，未引入外部事实

### 4. 组装并核验输出

- 构造 revised_materials 对象：每个文档包含文档名、修订后文本和该文档的 changes 列表
- 核对每个 change 的状态、reason、fact_basis 与问题来源一致
- 确认输出对象中不存在未在 fact_check_report 中出现的改动
- 调用一次 ReturnSkillResult 返回修订结果，之后不再补充额外建议或执行其他操作

Success criteria:

- revised_materials 是一个可直接供用户编辑或提交的结构化对象
- 存在至少一条已应用或被明确拒绝的改动，或所有问题都处于待确认状态且有原因说明

## Decision rules

- 核验报告建议优先采用，但当建议会引入画像之外的新事实时，改为删除问题表述或标记 pending_confirmation
- 当报告说某数字或职责夸大而画像没有可替代数值时，去掉该具体数值或职责表述，不自行估算
- 当报告指出前后不一致且画像能确定正确写法的，以画像写法为准并记录原因
- 当多处问题相互冲突时，按 user_profile 优先、核验报告事实依据其次的顺序裁决，并把冲突记录在 change.reason 中

## Outcome rules

### Success

- fact_check_report、draft_materials、user_profile 三个输入齐备
- report 中至少存在一条问题，且能定位到某个文档
- 输出对象中每个改动都能追溯到 report 中的一条问题
- 所有改动都落在事实边界内，或明确标记 pending_confirmation 并说明缺失证据

### Insufficient input

- fact_check_report 缺失、为空或不含任何问题条目
- draft_materials 缺失、为空，或 report 中引用的文档名无法匹配任何文档
- user_profile 缺失或无法提供任何可用于裁决的事实依据

### Error

- 无法把改动组合为结构合法的 revised_materials 对象
- ReturnSkillResult 调用未被接受


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "revised_materials": {
    "type": "object",
    "description": "应用核验结果修订后的材料文本，以及每条修改对应的原因说明，便于用户核对后继续编辑或提交"
  }
}
```

Declared consumers:
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- 逐一核对：每个 change 条目都存在对应的 fact_check_report 问题标识
- 逐一核对：所有 applied 改动的事实依据都来自 user_profile、核验报告事实依据或用户显式补充，未使用其他来源
- 确认 revised_materials 中不存在 report 之外的新增事实、数字或职责
- 确认每份文档的修订后文本保留了原结构，且未修改未被 report 标记的片段
- 确认未调用 WebSearch、WebFetch、Read、Write、Bash 或其他 Skill，仅使用输入快照和 ReturnSkillResult
