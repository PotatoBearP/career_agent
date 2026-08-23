---
name: check-material-format-compliance
description: "用户准备提交前需要把已准备好的材料清单与岗位要求的文件格式、篇幅、命名、语言逐项核对，并希望看到每项是否合规、问题在哪里、需要怎么改时使用；只有材料清单和至少一个岗位要求来源（已抽取要求或用户提供的岗位描述）可用时才触发。不用于事实核验、材料内容改写、缺失材料判断或代替用户提交材料。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 检查材料格式是否合规

材料格式合规审计员：只依据本次调用提供的材料清单、岗位要求来源和投递上下文做逐项核验，给出可回溯的合规结论，不做任何超出输入范围的调查或修改。

## Goal

对照目标岗位要求的文件格式、篇幅、命名和语言约束，逐项检查用户已准备的材料是否合规，并给出可直接执行的修改建议，确保报告中的每一项判断都可回溯到用户提供的材料信息和岗位要求来源。

## Hard boundary

- 只使用本次传入的 prepared_materials、target_opportunity、material_requirements、submission_context；不得读取本地文件、Profile、历史工件，不得调用 WebSearch、WebFetch、Read、Write、Bash 等普通工具获取或扩展输入。
- 不得编造或推导岗位不存在的格式要求；要求维度只来自 material_requirements 或 target_opportunity 中明确出现的内容，否则标记为未要求而非假设违规。
- 不得把材料内容本身纳入判断；只处理调用方提供的文档名称、文件格式、页数、语言、命名等元数据字段。
- 缺失字段不得判定为不合规；只能标记为 unverifiable 并在报告中列出需要用户补充确认的具体字段。
- 不得代替用户修改、导出、发送材料，也不得给出是否应当投递的整体建议；只产出格式核验报告。
- 只调用一次 ReturnSkillResult，并严格使用调用信封中的 skill_call_id 与 skill_name。

In scope:

- 逐项检查每份已准备材料的文件格式、篇幅、命名和语言是否满足岗位要求
- 对缺少字段或无法证明合规的维度标记为待确认，而不是直接判定违规
- 给出每项不合规或无法核验的问题说明、岗位要求原文来源和具体修改建议
- 在存在已抽取岗位要求清单时优先使用该结构化清单作为比对基准

The scenario alone defines the domain (`explicit`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `prepared_materials` (array, required; source `user_input`, acquisition `request_user`): 用户准备的材料清单，每项包含文档名称、文件格式、页数、语言和命名方式
- `target_opportunity` (object, required; source `user_input`, acquisition `request_user`): 目标岗位描述中的格式、篇幅、命名和语言要求
- `material_requirements` (object, required; source `prior_skill_output`, asset `material_requirements`, acquisition `prior_skill`): 可选：已梳理出的岗位材料要求清单，存在时优先作为格式核对基准
- `submission_context` (object, required; source `user_input`, acquisition `request_user`): 可选：投递平台和提交方式，用于补充额外的格式规则；未提供时按通用格式规则检查

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 冻结输入边界

- 从 skill-action-input 读取 prepared_materials、target_opportunity、material_requirements、submission_context。
- 确认 prepared_materials 为非空数组，且 target_opportunity 或 material_requirements 至少有一个包含格式约束信息。
- 不调用任何普通工具获取或补全输入。

Success criteria:

- 已确认四类输入中实际存在的字段。
- 已确定本次核验可用的要求来源。
- 输入不足时已进入 insufficient_input 分支而不是继续生成报告。

### 2. 抽取格式约束

- 从 material_requirements 中按材料种类抽取文件格式、页数上限、语言和命名规则；未提供该输入时，从 target_opportunity 中抽取同类约束。
- 为每一条约束记录 requirement_source，指向 material_requirements 或 target_opportunity 中的具体字段。
- 当两种来源同时存在且对同一材料同一维度冲突时，以 material_requirements 为准，并把冲突记入 conflicts_noted。
- 不把未出现的维度写入约束集。

Success criteria:

- 已得到一张 材料->维度->要求->来源 的约束表。
- 所有要求条目都有来源标识。
- 冲突项已记录。

### 3. 规范化材料元数据

- 遍历 prepared_materials 每一项，提取 document_name、file_format（扩展名或声明类型）、page_count、language、file_name。
- 把 file_format 统一转为小写字符串用于后续比较。
- 识别缺失或无法解析的字段，标记为 unknown_metadata，不在此阶段判定违规。

Success criteria:

- 每项材料都生成一条规范化记录。
- 缺失字段被单独列出。
- 没有材料条目被漏掉。

### 4. 逐维比对判定

- 对每个材料维度，按顺序应用 decision_rules 中的确定性比较规则。
- 文件格式：按小写规范化后的值精确比较，不一致判 non_compliant。
- 篇幅：当要求给出页数上限且 page_count 为可解析数字时比较大小；超出上限判 non_compliant；page_count 缺失或不可解析判 unverifiable。
- 命名：当要求给出命名规则或正则时比较 file_name，不匹配判 non_compliant；未给规则则不检查。
- 语言：当要求给出目标语言时与 language 精确比较，不一致判 non_compliant；未给要求则不检查。
- 任一维度 non_compliant 则该材料总体 non_compliant；无违规但存在 unverifiable 维度时总体 unverifiable；全部合规时总体 compliant。

Success criteria:

- 每个材料都有 per_dimension 结果。
- 每个判定都能回溯到输入字段和决策规则。
- 没有把 unknown_metadata 误判为违规。

### 5. 汇总并返回报告

- 生成 format_compliance_report 对象，写入 overall_summary、materials、requirement_sources_used、conflicts_noted。
- 为每处 non_compliant 或 unverifiable 写清 issue_description、requirement_source 和 corrective_action。
- 校验报告包含全部输入材料条目且 JSON 序列化正常。
- 调用 ReturnSkillResult 一次并结束本次 Skill 执行。

Success criteria:

- 报告结构完整、可被用户继续编辑使用。
- 所有输入条目、约束维度和来源都出现在报告中。
- 已执行且仅执行一次 ReturnSkillResult。

## Decision rules

- 要求来源优先级：material_requirements 存在时优先于 target_opportunity；同一维度冲突时采用 material_requirements，并在 conflicts_noted 中记录两项来源的原文。
- 文件格式比较：将文件扩展名或声明格式转为小写后做精确匹配；不一致即为 non_compliant。
- 页数比较：仅当要求明确给出页数上限且 page_count 可解析为数字时比较；page_count 缺失、为文本或不可解析时判 unverifiable，并列出需要用户确认的字段。
- 命名比较：仅当要求明确给出命名规则或正则表达式时对 file_name 做匹配；未给出规则时该维度不生成判定。
- 语言比较：仅当要求明确给出语言时与语言字段精确匹配；未给出要求则该维度不生成判定。
- 材料总体状态：存在任一 non_compliant 维度则材料为 non_compliant；否则存在任一 unverifiable 维度则材料为 unverifiable；否则为 compliant。
- 不允许把缺失字段、未给要求或无法解析的数据推断为合规或违规；一律显式标记 unknown_metadata 或未要求。

## Outcome rules

### Success

- prepared_materials 为非空数组。
- 至少存在一个可用的格式约束来源（material_requirements 或 target_opportunity）。
- 已对每个材料条目完成逐维比对并生成 format_compliance_report。
- 报告中所有判定都可回溯到输入字段与要求来源。

### Insufficient input

- prepared_materials 缺失、为空或不是数组。
- target_opportunity 未提供，且 material_requirements 也未提供。
- 提供的两个要求来源均不包含任何可识别的格式、篇幅、命名或语言约束。
- 输出结果只描述缺少哪些输入，不提出建议、不询问用户、不进行下一步行动。

### Error

- 输入结构无法被解析为预期类型，导致无法生成报告。
- ReturnSkillResult 调用失败或序列化失败。
- 内部出现与输入无关的执行异常；此时说明失败原因，不产出伪造的合规结论。


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "format_compliance_report": {
    "type": "object",
    "description": "每份材料的格式核验结果，包含合规状态、问题说明、岗位要求和具体修改建议"
  }
}
```

Declared consumers:
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- prepared_materials 中的每一个条目都至少出现一次在 format_compliance_report.materials 中。
- 每个判定维度都有明确状态：compliant、non_compliant、unverifiable 或 not_required。
- 每条 non_compliant 与 unverifiable 都有 issue_description、requirement_source 和 corrective_action。
- 任何要求文本都来自 material_requirements 或 target_opportunity 的明确内容，没有为凑结论编造约束。
- material_requirements 与 target_opportunity 冲突时已写入 conflicts_noted。
- 已且只调用一次 ReturnSkillResult。
