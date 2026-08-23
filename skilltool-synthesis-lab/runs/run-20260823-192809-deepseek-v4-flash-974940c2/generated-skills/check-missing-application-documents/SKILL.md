---
name: check-missing-application-documents
description: "用户准备投递某个岗位时，需要知道对照岗位材料要求还缺哪几份文件、每份应满足什么格式、应优先补齐哪些。仅当用户已提供目标岗位信息（或已有已梳理的材料要求产物）以及当前已备材料清单时使用。不要用于撰写或补全缺失材料，不要用于深度审查已有文件的格式合规性，不要用于重新生成或修改用户画像、岗位事实和投递排序。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 检查还缺哪些申请材料

材料要求核对员：只基于调用时输入和已声明的上游产物做逐项比对与缺口判定，不收集新证据、不生成缺失文件内容、不修改已确认的画像、岗位事实或投递排序。

## Goal

把目标岗位要求的材料文件与用户已准备的材料逐项比对，列出还缺哪几份、每份的格式要求和补齐优先级，全部基于用户提供和已验证的信息，不编造缺项。

## Hard boundary

- 只使用 prepared_materials、target_opportunity、application_focus_brief 和可选的 material_requirements；不得使用网络、本地文件、用户画像之外的材料或其他 Skill 结果扩充证据
- 不得把岗位要求中未明确列出的文件判定为缺失项
- 不得把岗位要求改写成用户已具备的能力，也不得修改用户画像、岗位事实或投递排序
- 每个缺失项必须能回溯到岗位要求来源与当前状态来源，禁止无来源结论
- 不撰写、补全或生成缺失材料的内容

In scope:

- 解析目标岗位要求提交的材料清单及格式约束，来源限定为 target_opportunity 或可选上游产物 material_requirements
- 逐项比对已备材料与岗位要求，识别缺失或不完整材料
- 按 application_focus_brief 和岗位要求中的强制程度给出补齐优先级
- 为每个缺失项标注来源并生成可编辑、可导出的 missing_documents_report

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `prepared_materials` (array, required; source `user_input`, acquisition `request_user`): 用户已准备的材料清单，每项包含文档名称、格式状态和是否完成
- `target_opportunity` (object, required; source `user_input`, acquisition `request_user`): 目标岗位描述或材料要求说明，用于确定要交哪些文件和格式约束；与已验证岗位信息一致时可只提供岗位标识
- `material_requirements` (object, required; source `prior_skill_output`, asset `material_requirements`, acquisition `prior_skill`): 可选：已梳理出的岗位材料要求清单，存在时优先作为比对基准
- `application_focus_brief` (object, required; source `upstream_artifact`, asset `application_focus_brief`, acquisition `provided`): 投递材料准备要点，用于判断缺失材料的优先顺序

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 解析岗位要求基准

- 优先读取 material_requirements 中的材料种类清单及其格式约束；该产物缺失时，从 target_opportunity 解析明确列出的要提交材料及格式、篇幅、语言、命名等约束
- 只保留能指出处的材料项；岗位描述未列出的材料不得加入要求清单
- 若 target_opportunity 仅提供岗位标识，则以 material_requirements 为唯一基准；两者都不可用时返回 insufficient_input

Success criteria:

- 得到一组带来源的岗位要求材料项，并且 material_requirements 或 target_opportunity 至少一项能够支撑
- 要求清单中没有无法回溯来源的项

### 2. 建立已备材料索引

- 从 prepared_materials 数组逐项提取文档名称、文档类型、格式状态、是否完成，保留原始条目以便回溯
- 按语义判断名称等价关系（例如简历与 CV 视为同一材料），但不得把格式状态为未完成或缺失的项视为已准备
- 索引必须覆盖数组全部条目

Success criteria:

- 每个已备条目都能回答其对应的文档类型与完成状态
- 同义不同名的条目能被识别为等价，不因措辞差异误判

### 3. 逐项比对生成缺失项

- 对每个岗位要求项，在已备材料索引中查找语义等价项
- 标记缺失项：要求中存在但无等价已备项，或已备项状态明确为未完成
- 为每个缺失项记录文档名/要求项、对应格式要求、当前状态、来源（material_requirements 或 target_opportunity 负责要求，prepared_materials 负责状态）

Success criteria:

- 每个缺失项同时可回溯到岗位要求来源和当前状态结论
- 未标记任何无岗位要求依据的缺失项

### 4. 计算补齐优先级

- 主键：岗位要求中的强制/必须材料优先于推荐/可选材料
- 次键：application_focus_brief 中标注为关键环节对应的材料优先
- 再次：完全未准备优先于已开始但未完成
- 为每个缺失项输出 1 以内的一句优先级理由并标注依据来源

Success criteria:

- 优先级排序可解释且每条理由可回到 application_focus_brief、岗位要求或当前状态

### 5. 组装缺失材料报告

- 生成 missing_documents_report：summary 说明基于当前输入范围的总缺项数；missing_items 数组逐项包含缺失文件、对应格式要求、当前状态、补齐优先级、优先级理由和信息来源
- 没有任何缺失时 missing_items 为空数组，并在 summary 中说明基于当前输入材料已齐备
- 报告保持结构化以便用户继续编辑或导出

Success criteria:

- 报告字段完整且每个字段内容均来自输入或上游产物
- 未包含任何编造的缺失文件、格式要求或优先级结论

## Decision rules

- 缺失判定规则：岗位要求项在已备索引中无语义等价项，或等价项状态为未完成时，才记为缺失项
- 优先级规则：强制材料 > 推荐材料；同档内 application_focus_brief 关键环节的材料优先；再同档内完全未准备优先于未完成
- 要求来源冲突时，material_requirements 优先于从 target_opportunity 现场解析的结果，并在来源字段同时注明

## Outcome rules

### Success

- 岗位要求基准可确定且 prepared_materials 可解析
- 生成 missing_documents_report，每个缺失项具备格式要求、当前状态、优先级和信息来源

### Insufficient input

- 可以解析的材料要求基准不存在：material_requirements 缺失且 target_opportunity 未包含可用于提取材料清单的信息
- prepared_materials 不是可解析的材料清单时，仅报告该事实，不猜测缺哪些材料

### Error

- 输入数据结构损坏导致无法完成第 1 至第 3 步的确定性处理
- 结果序列化或返回阶段失败


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "missing_documents_report": {
    "type": "object",
    "description": "缺失材料清单，包含缺失文件、对应格式要求、当前状态、补齐优先级和信息来源"
  }
}
```

Declared consumers:
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- 每个缺失项都能回溯到岗位要求来源（material_requirements 或 target_opportunity）与当前状态来源（prepared_materials）
- 报告中未包含任何岗位画像、岗位事实或投递排序的修改
- 没有把任何岗位要求改写成用户已具备的能力，也没有新增岗位要求之外的缺失项
- 缺失项格式要求与当前状态均未超出输入内容
- 调用 ReturnSkillResult 前完成以上断言并只调用一次
