---
name: network-contact-matcher
description: "当用户请我们从其手头的现有联系人名单中找出哪些人可能对目标机会有帮助时触发。不要在用户没有提供联系人名单、目标机会清单或接触规则时使用；不要用于寻找公开网络内推入口、撰写联系消息或实际发送联系请求。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 现有人脉资源匹配分析

证据边界内的关系匹配评审员：只审查本次调用已提供的联系人、机会、画像和规则，不访谈用户、不调查网络、不替用户做决定。

## Goal

仅依据用户明确提供的关系名单、已确认的机会清单、用户画像和接触规则，筛选出与目标机会相关、可以自然接触的人，输出可匹配的熟人内推线索清单，保留关系来源、匹配依据、推荐的联系方式范围，不猜测私人联系方式或虚构关系。

## Hard boundary

- 只使用 user_contact_list、verified_opportunity_list、user_profile、user_contact_rules 四个输入字段；不得读取本地文件、搜索网络、调用其他 Skill 或 MCP。
- 所有关系来源与共同交集必须来自用户提供的联系人条目或用户画像；不得从姓名、昵称或职位名称反推私人关系和任职经历。
- 不得输出电话、邮箱、住址、真人社交账号等私人联系方式；contact_reachability_scope 只能给出渠道类别范围，如平台内私信或官方入口。
- 不得虚构校友、同事、熟人背书或已获得推荐；对不确定的任职关系明确标记为低置信度或不可确认。
- 不得发送、预约、撤回或修改任何外部系统状态；本能力只生成可供用户判断的线索清单。

In scope:

- 校验用户提供的关系名单、机会清单和接触规则
- 从联系人条目中提取可核验的关系与任职证据
- 把联系人与已确认机会按机构、团队、领域、共同背景做可追溯匹配
- 按用户接触规则排除不可联系的人并限定联系方式范围
- 输出 dedupe_key 为 contact_id|matched_opportunity_ids|relationship_source 的线索清单

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `user_contact_list` (array, required; source `user_input`, acquisition `request_user`): 用户明确提供的关系名单，每条含称呼、关系类型、公开可核验信息或来源，不允许猜测联系方式和共同经历
- `verified_opportunity_list` (array, required; source `upstream_artifact`, asset `verified_opportunity_list`, acquisition `provided`): 用户已经确认的真实机会清单，用于匹配联系人可能关联的机会
- `user_profile` (object, required; source `upstream_artifact`, asset `user_profile`, acquisition `provided`): 用户已有的画像信息，用于判断关系与用户背景的真实交集
- `user_contact_rules` (object, required; source `user_input`, acquisition `request_user`): 用户对联系方式的限制、可透露的信息范围以及哪些人暂时不想打扰

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 解析并校验输入

- 读取 user_contact_list、verified_opportunity_list、user_profile、user_contact_rules 四个字段并校验类型。
- 若 user_contact_list 为空、verified_opportunity_list 为空或 user_contact_rules 缺失，进入 insufficient_input。
- 从 verified_opportunity_list 为每个机会提取 id、机构、团队、领域、岗位、地点等可匹配信号；只使用该清单中已存在的事实。

Success criteria:

- 输入类型正确且四个字段齐全
- 每个机会都有至少一个从清单中提取的可匹配信号

### 2. 构建联系人匹配依据

- 逐条检查 user_contact_list：每条联系人必须含用户提供的关系类型、机构/团队/任职信息，或明确的关系说明（如“在X公司”“曾在Y团队”“是校友”）。
- 无任何可匹配依据的联系人标记为不可用并从结果中排除。
- 仅当用户联系人条目已声明共同背景且 user_profile 中有对应真实事实时，才用画像补全共同交集；不得用画像制造新关系。

Success criteria:

- 每条可用联系人都有可追溯的证据令牌和来源
- 所有不可用联系人都被记录但不进入输出
- 若所有联系人都不可用，进入 insufficient_input

### 3. 执行匹配与分级

- 将每条可用联系人的证据令牌与每个机会的信号做逐项比较。
- strong：联系人任职机构/团队与机会机构/团队相同或包含；或用户明确说明其在相关团队且领域一致。
- weak：仅有相近领域、地点或共同社区，但无明确任职关联；confidence 标记为 low 并保留未知项。
- none：无明确关联信号；该联系人不进入结果。
- 保存 contact_id、matched_opportunity_ids、relationship_source、match_basis、match_grade 的映射。

Success criteria:

- 每条入选联系人至少匹配一个机会且带分级依据
- weak 匹配明确标注不确定性，不把推测当事实

### 4. 套用用户联系规则并限定可达范围

- 将 user_contact_rules 应用于候选结果：排除用户暂时不想打扰的人、标记被排除的渠道、遵守频率上限。
- 为每个候选联系人确定 contact_reachability_scope，只能落在用户允许的渠道类别内，如平台内私信、官方页面入口。
- 被规则排除的联系人不得出现在输出中。

Success criteria:

- 输出集合与所有用户规则一致
- 被排除联系人在最终数组中不可见

### 5. 构造结果数组并去重

- 为每个入选联系人构造条目，字段为 contact_id、matched_opportunity_ids、relationship_source、match_basis、match_grade、contact_reachability_scope、suggestion。
- 按 contact_id|matched_opportunity_ids|relationship_source 去重。
- 若经过匹配与规则过滤后没有入选联系人，返回成功且数组为空；空数组对“我的联系人里没有人能帮上忙”是合法结果。

Success criteria:

- 数组字段完整、类型正确、已去重
- 空数组仅表示无匹配，不表示输入缺失或失败

### 6. 最终校验并返回

- 确认所有 matched_opportunity_ids 都存在于 verified_opportunity_list。
- 确认 relationship_source 与 match_basis 均可追溯到用户输入或用户画像，无编造事实。
- 确认输出不含私人联系方式、被排除联系人或来自网络的信息。
- 调用 ReturnSkillResult 且仅调用一次，按 skill_call_id 写入结果。

Success criteria:

- 全部校验通过
- 已完成一次且仅一次 ReturnSkillResult

## Decision rules

- strong 匹配＝明确任职机构/团队与机会一致，或用户明确表述相关关系且领域重合；weak 匹配＝仅有近似领域、地点或共同社区且无明确任职；none＝不进入结果。
- 缺少用户提供的关系类型或可核验来源的联系人一律不进入结果，防止凭姓名或昵称猜测关系。
- 同位素排序：strong 排在 weak 前；同级内按用户提供的联系人顺序排序，不引入外部权重。
- user_contact_rules 中的排除项优先于任何匹配结果；渠道排除项直接写入 contact_reachability_scope 的不可用集合。
- 结果去重键固定为 contact_id|matched_opportunity_ids|relationship_source。

## Outcome rules

### Success

- 四个输入字段完整且类型正确
- 至少存在一条可用联系人可供匹配
- 匹配与规则过滤完成并产出合法数组
- 空数组在“确实无匹配”时仍视为 success

### Insufficient input

- user_contact_list 为空
- verified_opportunity_list 为空
- user_contact_rules 缺失
- 所有联系人条目都缺乏任何可匹配的身份、任职或关系依据

### Error

- 输出不是 array 或条目缺少必填字段
- 序列化或校验阶段出现无法修复的内部异常


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "matched_network_lead_list": {
    "type": "array",
    "description": "从用户提供的联系人中筛出的可接触线索，含匹配机会、关系来源和推荐的联系方式范围"
  }
}
```

Declared consumers:
- task_sequence_outreach_leads
- task_compare_outreach_leads
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- matched_network_lead_list 是数组且每条包含 contact_id、matched_opportunity_ids、relationship_source、match_basis、match_grade、contact_reachability_scope、suggestion
- 所有 matched_opportunity_ids 均在 verified_opportunity_list 中且可查证
- 输出来源只引用 user_contact_list、user_profile 或 user_contact_rules，无网络或推测内容
- 没有输出电话、邮箱、住址、个人账号等私人联系方式
- 被 user_contact_rules 排除的联系人不在结果中
- 调用 ReturnSkillResult 且只调用一次
