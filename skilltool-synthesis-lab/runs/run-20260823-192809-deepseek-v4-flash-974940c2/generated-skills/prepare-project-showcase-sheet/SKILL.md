---
name: prepare-project-showcase-sheet
description: "当用户已经有一份按岗位要求改写好的项目经历列表，并希望整理成一页纸可随申请提交的项目作品清单或项目附页时使用。不要用于从零撰写项目经历、核验项目事实的真实性、按岗位重新改写项目表述，或代替用户向外部岗位发送材料。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 做一页纸的项目作品清单

作为申请材料整理者，只依据本次调用提供的改写项目经历、用户偏好和可选目标岗位，生成结构化的一页纸项目清单内容；不做调研、不询问用户、不写文件、不发送材料。

## Goal

把已经按岗位要求改写好的项目经历整理成一页纸、可随申请提交的项目作品清单内容，按项目组织并呈现名称、承担角色、关键动作和结果，同时附上排版建议。

## Hard boundary

- 只使用本次调用提供的 rewritten_project_descriptions、showcase_preferences 和 target_opportunity 三个输入，不读取用户画像、岗位清单或任何未声明数据源。
- 每个条目的项目名称、角色、关键动作和结果都必须能在 rewritten_project_descriptions 中找到对应内容，不得编造、放大或补充数字与成果。
- 本能力只做筛选、排序、压缩和排版组织，不重新改写项目表达，也不评估项目事实是否真实。
- 不生成文件，不接触投递平台，不代替用户提交或发送任何材料。
- 项目条目中缺失的名称、角色或结果字段，一律标记为待补充，不猜测填充。

In scope:

- 筛选与岗位最相关的项目
- 决定项目在清单中的排序
- 将每个项目压缩为名称、承担角色、关键动作和结果
- 按用户偏好处理语言、篇幅和排序方式
- 生成一页纸清单内容及排版建议
- 为未提供的事实保留待补充标记

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `rewritten_project_descriptions` (object, required; source `prior_skill_output`, asset `rewritten_project_descriptions`, acquisition `prior_skill`): 已按岗位要求改写好的项目经历描述，作为作品清单的内容来源
- `showcase_preferences` (object, required; source `user_input`, acquisition `request_user`): 用户对篇幅、语言、排序方式以及是否保留链接或证明材料占位的要求
- `target_opportunity` (object, required; source `user_input`, acquisition `request_user`): 目标岗位的职责和关注点，用于筛选最相关的项目；不提供时按现有项目完整整理

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 装载并校验输入

- 读取 rewritten_project_descriptions，确认它是包含一个或多个项目条目的 object。
- 读取 showcase_preferences，提取语言、篇幅限制、排序方式和链接/证明占位要求。
- 可选读取 target_opportunity，判断是否存在可用于筛选的岗位职责关键词。
- 若 rewritten_project_descriptions 或 showcase_preferences 缺失或为空，进入 insufficient_input。

Success criteria:

- 已锁定三个输入字段及其类型
- 已确认目标岗位是否存在

### 2. 抽取可展示事实

- 对每个项目条目抽取 project_name、role、key_actions、result 和 related_skills。
- 只使用输入中实际出现的字段；缺失字段记入该条目的 missing_fields。
- 保留每个事实与该条目的对应关系，供最终校验追溯。

Success criteria:

- 每个条目都有事实来源映射
- 缺失字段清单已生成

### 3. 筛选与排序

- 若 target_opportunity 存在，按岗位职责/关键词与每个项目 actions、result、skills 的重合度降序排列。
- 若 target_opportunity 不存在，按带看 showpreferences 中的排序要求执行，否则保持输入顺序。
- 若 showcase_preferences 含 max_items 或 page_limit，按排序结果截取；未含则保留全部项目。

Success criteria:

- 排序规则已应用
- 条目数量满足限制或保留全部

### 4. 压缩汇编与排版建议

- 逐条把内容压缩为名称、角色、一到两条关键动作和结果，直接保留原文事实，不做扩展。
- 应用 showcase_preferences 中的语言和篇幅要求。
- 生成 sheet 的 entries 结构，并在 layout_suggestions 中给出标题、分栏、每页条目数和链接/证明占位的排版建议。

Success criteria:

- 每条内容可以容纳在一页纸范围内
- 语言偏好已应用
- layout_suggestions 已生成

### 5. 最终校验与返回

- 逐条核对 entries 中的事实是否都可回溯到 rewritten_project_descriptions。
- 检查是否存在编造的成果、数字或角色。
- 确认 project_showcase_sheet 对象包含 entries 与 layout_suggestions。
- 调用 ReturnSkillResult 一次并结束本 Skill 调用。

Success criteria:

- 所有条目可回溯到输入
- 输出对象结构完整
- 已唯一一次返回成功结果

## Decision rules

- 相关性排序：统计 target_opportunity 文本中的职责/关键词在每个项目条目的 actions、result、skills 字段中的出现次数，按出现次数降序排列；同分时保持输入原顺序。
- 截断规则：仅当 showcase_preferences 明确给出 max_items 或 page_limit 时截断；未给出则保留全部项目。
- 事实压缩规则：压缩只删除修饰语和解释性语句，不改变动作发出者、行为范围和结果；任何结果数字必须来自原文。
- 待补充规则：缺少 project_name、role 或 result 时，在该条目标记待补充，不得自行构造。

## Outcome rules

### Success

- 至少一个项目条目被纳入 entries，且该条目的名称、角色、关键动作和结果均可回溯到输入
- target_opportunity 未提供时仍返回完整的项目清单而不是报错
- project_showcase_sheet 包含 entries 和 layout_suggestions
- showcase_preferences 中明确的语言或篇幅要求已生效

### Insufficient input

- rewritten_project_descriptions 缺失或为空
- showcase_preferences 缺失或无法解析
- 没有任何可用的项目条目可以展示

### Error

- 输入类型与声明不符导致无法解析
- 输出对象无法序列化
- ReturnSkillResult 未被调用或调用失败


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "project_showcase_sheet": {
    "type": "object",
    "description": "可随申请提交的一页纸项目清单内容，按项目组织，每条包含名称、角色、关键动作和结果，并附排版建议"
  }
}
```

Declared consumers:
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- project_showcase_sheet.entries 中的所有事实都可回溯到 rewritten_project_descriptions
- 未新增任何数字、成果或角色表述
- showcase_preferences 中明确的语言、篇幅、排序规则已生效
- 未读取 user_profile、verified_opportunity_list 等未声明输入
- 未写文件，也未向外部发送材料，只返回结构化结果并调用一次 ReturnSkillResult
