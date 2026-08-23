---
name: draft-targeted-cover-letter
description: "用户为某个真实岗位请求一版求职信或自荐信，且已经具备岗位描述、用户画像、投递材料准备要点和使用偏好（语言、篇幅、语气、称呼）。当用户只是泛泛要求‘写一封求职信’且没有指定岗位，或需要先进行方向探索、岗位匹配、简历改写、事实核验或对外发送材料时，不要使用本能力。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 写一封有针对性的求职信

求职信写作者兼证据审查者：在冻结的岗位描述、用户画像和投递要点内，生成一封真实、针对岗位、可直接编辑的求职信草稿，且克制在证据边界内。

## Goal

在证据范围内，根据目标岗位要求、用户画像和投递材料准备要点生成一封结构完整、针对岗位的求职信草稿，供用户编辑、导出或提交。

## Hard boundary

- 只使用调用时已可见的 target_opportunity、user_profile、application_focus_brief 和 letter_preferences，不读取其他文件、不搜索网络、不向用户追问补充材料。
- 不得编造或夸大经历、数字、职责、成果、技能；岗位描述中的要求不能自动转写成用户已具备的能力。
- 不得代替用户发送、投递或对外提交任何求职信；输出只是草稿。
- job posting 中缺少的字段（如联系人、公司背景）记为 unknown，不得编造；宁可省略或使用通用表述。
- ReturnSkillResult 之后不再输出额外指导、版本说明或后续步骤。

In scope:

- 解析目标岗位的职责、要求关键词、公司/组织背景和提交说明
- 从 user_profile 与 application_focus_brief 中挑选与岗位要求对应的真实经历作为支撑
- 按 letter_preferences 的语言、篇幅、语气、称呼和建议突出内容生成求职信草稿
- 输出可直接编辑、导出或提交的 cover_letter_draft 字符串

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `target_opportunity` (object, required; source `user_input`, acquisition `request_user`): 目标岗位的职责、要求、公司或组织背景以及材料提交说明
- `user_profile` (object, required; source `upstream_artifact`, asset `user_profile`, acquisition `provided`): 已确认的用户画像，用于选取真实、相关的经历作为求职信支撑
- `application_focus_brief` (object, required; source `upstream_artifact`, asset `application_focus_brief`, acquisition `provided`): 投递材料准备要点，用于确认求职信应突出的重点
- `letter_preferences` (object, required; source `user_input`, acquisition `request_user`): 用户对求职信语言、篇幅、语气、称呼和希望突出经历的要求

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 解析岗位与写作约束

- 从 target_opportunity 中提取职位名称、核心职责、要求关键词、公司/组织背景和材料提交说明；信息缺失的维度记录为 unknown，不推断。
- 从 letter_preferences 中提取语言、篇幅、语气、称呼和期望突出的经历；缺失时使用保守默认：语言与岗位描述一致、单页篇幅、专业语气、按提交说明选用称呼。
- 从 application_focus_brief 中提取针对该岗位的投递重点，作为后续匹配来源之一。

Success criteria:

- 得到职位名称与至少一组职责/要求关键词，或能够结合 application_focus_brief 明确岗位针对性
- 明确语言、篇幅、语气、称呼，或已记录使用的默认值

### 2. 冻结证据范围并盘点事实

- 仅使用 user_profile 与 application_focus_brief 中的字段作为事实来源，不引入输入之外的信息。
- 列出可用的教育、项目、研究、实验、报告撰写和技能事实，并为每条记录所在字段作为来源。
- 对没有具体数字、结果或完成状态的条目，只保留定性表述，不得补写量化成果。

Success criteria:

- 每条拟使用事实都能定位到 user_profile 或 application_focus_brief 的可见字段
- 没有引入输入之外的新事实、数字或成果

### 3. 匹配并挑选支撑经历

- 将目标岗位的核心职责与要求关键词同证据条目做语义匹配，选出 2-3 条最直接的证据作为信稿支撑。
- 匹配优先级：职责/关键词与证据直接对应 高于 主题相关且有具体动作 高于 主题相关但缺少结果；同层优先选择描述更具体且有明确来源的条目。
- 若没有可匹配证据，只表达对岗位的兴趣和对岗位要求的理解，不编造匹配。

Success criteria:

- 选出的每条证据都能对应特定职责或要求关键词
- 没有任何岗位要求被改写为用户已具备的能力

### 4. 起草求职信

- 按 letter_preferences 或默认值生成：称呼、开头点明申请岗位、1-2 段证据匹配说明、结尾行动建议、落款。
- 严格使用已盘点事实；对无证据的数字、角色、成果一律省略或用定性表述。
- 控制篇幅：未指定时不超过一页（约 400-500 字）；使用指定或默认语言与语气。
- 提交说明中的联系人用于称呼，无联系人时使用通用称呼。

Success criteria:

- 信稿包含开头、匹配经历说明和结尾行动建议
- 语言、篇幅、语气符合指定值或默认值
- 每个可核查断言都能回溯到输入字段

### 5. 校验并返回结果

- 通读草稿，删除任何无法溯源或夸张的表述；确认没有虚假数字、编造公司/项目/产出，或把岗位要求写成已有能力。
- 确认 cover_letter_draft 是字符串且符合输出描述。
- 以 skill_call_id 和 skill_name 调用 ReturnSkillResult 一次，然后结束本次调用。

Success criteria:

- 校验通过且未发现越界事实
- 恰好调用一次 ReturnSkillResult

## Decision rules

- 证据匹配优先级：职责关键词直接对应 > 主题相关且有具体动作 > 主题相关但缺少结果；同层选择描述更具体且有来源的条目。
- 证据冲突处理：user_profile 与 application_focus_brief 对同一事实描述不一致时，以 user_profile 为准，application_focus_brief 仅作补充视角；冲突内容内部标记不确定，不写入确凿断言。
- 语言规则：letter_preferences 指定语言用之；否则使用岗位描述语言；仍无法确定时使用 user_profile 上下文语言并在内部记录 default。
- 篇幅与称呼规则：letter_preferences 指定则遵循；否则默认单页、默认称呼，不编造联系人姓名。
- 无证据的量化信息一律省略，宁可使用‘独立完成’‘参与了’等与证据一致的程度词，也不补写指标。

## Outcome rules

### Success

- target_opportunity 提供职位名称与至少部分职责/要求，或 application_focus_brief 提供可判断的岗位针对性
- user_profile 或 application_focus_brief 至少提供一个可支撑的事实
- cover_letter_draft 生成为字符串，包含开头、匹配经历说明和结尾行动建议，且符合指定或默认的语言、篇幅与语气

### Insufficient input

- target_opportunity 缺失、为空，或未包含任何职位名称、职责、要求或提交说明，无法判断针对什么岗位写作
- user_profile 与 application_focus_brief 均缺失或为空，没有可用的事实基础

### Error

- 输入类型不符合 schema（例如 target_opportunity 不是 object）
- 无法序列化 cover_letter_draft，或 ReturnSkillResult 调用失败


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "cover_letter_draft": {
    "type": "string",
    "description": "针对目标岗位的求职信草稿文本，包含开头、匹配经历说明和结尾行动建议"
  }
}
```

Declared consumers:
- task_draft_email_out_of_cover_letter
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- cover_letter_draft 中每个可核实的断言都能回溯到 user_profile 或 application_focus_brief 字段
- 信稿包含开头、匹配经历说明和结尾行动建议，且未出现编造的数字、公司、角色或成果
- 语言、篇幅、语气、称呼符合 letter_preferences 或已声明的默认值
- 未把岗位要求改写成用户已具备的能力
- 恰好调用一次 ReturnSkillResult，之后未追加任何额外内容
