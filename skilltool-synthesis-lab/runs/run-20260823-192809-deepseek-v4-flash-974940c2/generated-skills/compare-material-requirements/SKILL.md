---
name: compare-material-requirements
description: "用户一次给出两个具体岗位，希望并排看清这两个岗位在材料种类、格式、侧重点、截止时间和复用可能性上的异同时使用。不应在只有一个岗位、岗位无法识别、或用户要求从若干机会中筛选/排序时使用；也不用于生成简历、项目经历或求职信本身。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 对比两个岗位的材料要求

岗位材料要求比对员：在冻结的输入证据范围内，把两个岗位的材料要求拆解到一致维度并进行保守比对，输出差异、可复用项与需单独项，不负责投递排序或材料生成。

## Goal

把两个目标岗位需要提交的材料种类、格式约束、侧重点、截止时间和可复用部分整理成字段级对照表，并基于可复用性规则给出哪些材料可共用、哪些需要单独调整的结论，供用户直接决定材料准备顺序和复用策略。

## Hard boundary

- 只使用 opportunity_pair、verified_opportunity_list、application_focus_brief 三个输入；不联网搜索、不读取用户画像文件、不调用其他 Skill 或工具。
- 输入的 opportunity_pair 必须包含可识别的两个岗位；缺少其中一个岗位时直接返回 insufficient_input，不猜测、不补全用户没说清的第二岗位。
- 不生成或改写简历、项目经历、求职信等材料内容，不对两个岗位做投递优先排序。
- 不允许编造或推断未在输入资料中出现的材料要求、格式约束或截止时间；资料未说明的字段统一标记为 unspecified，而不是填入默认值。
- 当用户提供描述与已验证岗位清单冲突时，必须同时记录两个来源并标记 requires_confirmation，不静默选择其中一个。

In scope:

- 解析并核对用户指定的两个岗位
- 按材料种类、格式约束、侧重点、截止时间和可复用性组织对照表
- 输出可直接复用的材料、需单独准备或调整的材料、以及要求差异
- 保留每个要求的信息来源（用户提供描述或已验证岗位清单）
- 标记冲突或未说明的字段并要求用户确认

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `opportunity_pair` (object, required; source `user_input`, acquisition `request_user`): 用户选择对比的两个岗位标识或岗位描述，包含各自材料要求
- `verified_opportunity_list` (array, required; source `upstream_artifact`, asset `verified_opportunity_list`, acquisition `provided`): 已验证的真实岗位机会清单，用于补充岗位的准确信息
- `application_focus_brief` (object, required; source `upstream_artifact`, asset `application_focus_brief`, acquisition `provided`): 投递材料准备要点，用于判断各岗位的材料重点差异

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 解析并核对两个岗位

- 从 opportunity_pair 中读取岗位 A 和岗位 B 的标识或描述；支持岗位 id、岗位名称或带材料要求的描述文本。
- 当标识存在时，在 verified_opportunity_list 中查找对应机会；找到则使用其已验证信息补充岗位事实。
- 若 opportunity_pair 中某个岗位没有任何可识别信息，或两个岗位指向同一岗位，则停止并返回 insufficient_input。

Success criteria:

- 两个岗位均已识别且可以区分
- 每个岗位都关联了至少一个事实来源（用户描述或已验证岗位清单）

### 2. 逐岗位提取材料要求

- 对每个岗位分别提取：材料种类、每类材料的格式约束、材料侧重点、截止时间。
- 提取时以岗位自身来源为准；application_focus_brief 只用于解释侧重点差异，不得作为材料种类或格式的唯一来源。
- 对无法确认的字段标记 unspecified，并在记录中注明该字段缺少来源。

Success criteria:

- 每个岗位得到一份材料要求清单，字段均带来源标记（user_description 或 verified_list）
- 无来源的字段被标记为 unspecified 且未填入推测值

### 3. 构建一致性对照表

- 以四个维度组织对照：material_kinds、format_constraints、material_focus、deadlines。
- 每个维度记录岗位 A 值、岗位 B 值、来源标记和差异说明；两岗位值相同时差异说明写入 same。
- 对照表不进行优劣判断，只描述是否一致、一致在哪些内容、差异在哪些内容。

Success criteria:

- 四个维度均出现在 alignment_matrix 中
- 每个单元格都有 A 值、B 值、来源与差异说明
- 未出现对岗位优劣或投递优先级的结论

### 4. 判定可复用与需单独准备

- 对每种材料按下述规则分类：材料种类和格式约束在两个岗位中均明确且一致时归为 reusable；种类一致但格式、篇幅、语言或侧重点要求不同时归为 needs_adjustment；仅单一岗位要求时归为 separate。
- 任一岗位对某材料要求 unspecified 时，不将其归为 reusable，而归入 requires_confirmation。
- 每条分类结论必须写出依据，例如引用两岗位各自的格式字段。

Success criteria:

- reusable_materials、separately_prepared_materials、needs_adjustment 均给出条目和依据
- 没有依据被编造；unspecified 的材料未进入 reusable

### 5. 汇总冲突并返回结果

- 汇总所有来源冲突（用户描述与 verified_opportunity_list 不一致）和字段缺失（如某一岗位未说明截止时间），写入 unresolved_conflicts。
- 调用 ReturnSkillResult 一次，返回 comparison_matrix 结果对象。

Success criteria:

- unresolved_conflicts 非空时逐条标明需要用户确认的内容
- ReturnSkillResult 只调用一次，输出 comparison_matrix

## Decision rules

- 维度固定顺序：material_kinds、format_constraints、material_focus、deadlines。
- 来源优先级不采用静默覆盖：当 user_description 与 verified_list 对同一字段给出不同值，同时保留两值并在 unresolved_conflicts 中要求用户选择。
- 可复用判定规则：reusable 仅当两岗位对材料种类和全部格式约束都明确且一致；needs_adjustment 当种类一致但任一格式要素不同；separate 当仅一个岗位要求该材料；requires_confirmation 当任一方字段 unspecified。
- 所有与岗位相关的事实表述必须能追踪到具体输入来源，禁止把 application_focus_brief 中的一般性说明转写成岗位的硬性材料要求。

## Outcome rules

### Success

- 成功识别两个不同岗位
- 每个岗位至少有一个材料要求来源，且能提取出至少一项可对比的材料要求
- 生成包含 opportunities、dimensions、alignment_matrix、reusable_materials、separately_prepared_materials、unresolved_conflicts 的 comparison_matrix

### Insufficient input

- opportunity_pair 中缺少任一个岗位的可识别信息
- 两个岗位无法区分或实际是同一岗位
- 两个岗位都没有任何材料要求信息可供对比

### Error

- 输入结构无法读取（如 opportunity_pair 不是对象或字段缺失导致无法解析）
- 输出序列化失败或 ReturnSkillResult 调用失败


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "comparison_matrix": {
    "type": "object",
    "description": "两个岗位在材料种类、格式、侧重点、可复用部分和截止时间上的对照结果"
  }
}
```

Declared consumers:
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- comparison_matrix.opportunities 中同时包含两个可区分的岗位标识
- alignment_matrix 的每个维度单元格都包含 A 值、B 值、来源标记和差异说明
- reusable_materials 中没有任何条目依赖 unspecified 字段
- 未出现对任一岗位的优劣评价或投递优先级结论
- 所有截止时间、格式、材料种类都能追溯到用户输入或已验证岗位清单
- ReturnSkillResult 恰好调用一次
