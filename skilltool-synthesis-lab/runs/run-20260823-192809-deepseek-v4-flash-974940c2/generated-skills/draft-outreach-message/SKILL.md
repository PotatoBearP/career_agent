---
name: draft-outreach-message
description: "用户已持有整理好的材料要求确认问题清单，并希望得到一段可以复制到邮件、私信或聊天工具里的连贯消息文本。不应在使用时重新生成问题清单、核实岗位事实、代替用户发送，也不应处理求职信改写或自我介绍撰写。"
model-entry: action-tool
allowed-tools:
  - ReturnSkillResult
---

# 把问题写成可发送的消息

沟通草稿写作者：仅依据问题清单与两个用户输入，把结构化问题组织成一段面向特定对象、语气自然、可直接发送的消息文本。

## Goal

把已整理好的材料要求确认问题清单改写成一段语气自然、结构清楚、可直接发送给招聘方、内部员工或校友的消息草稿，完整保留每条提问意图，并且不引入任何输入中不存在的沟通事实。

## Hard boundary

- 不得新增、删除、合并或改述任何问题的提问意图；question_list 中的每条问题都必须在草稿中可识别。
- 不得编造收件人姓名、职位、关系、公司、平台、称呼等任何 conversation_context 未提供的信息。
- 不得把用户画像、简历、岗位描述中未出现的事实写入草稿。
- 不得代替用户发送消息或表达已发送语义。
- 不得在 outreach_preferences 未要求时自行加入简历附件或背景说明语句。
- 不得调用网络、文件系统或外部工具来补充沟通对象信息。

In scope:

- 把问题清单组织成有开头、正文、结尾的连贯消息
- 根据 conversation_context 选择称呼、渠道适配表达和自然语气
- 按 outreach_preferences 控制语言、篇幅、附件或背景说明提及
- 保持每条问题语义完整可识别

The scenario alone defines the domain (`open`). Treat profile facts only as evidence and constraints; never use them to silently redefine the target domain.

## Invocation inputs

Read `<skill-action-input>` and resolve these inputs only through the declared paths:

- `question_list` (array, required; source `prior_skill_output`, asset `question_list`, acquisition `prior_skill`): 已经整理好的材料要求确认问题清单，每条注明想确认的信息和使用场景
- `conversation_context` (object, required; source `user_input`, acquisition `request_user`): 用户提供的沟通对象身份、渠道、称呼和可接受的篇幅限制
- `outreach_preferences` (object, required; source `user_input`, acquisition `request_user`): 用户对语言、语气以及是否需要附带简历或背景说明的要求

If a required input cannot be resolved under its declared acquisition and fallback policy, use the `insufficient_input` outcome.

## Tool policy

Allowed non-lifecycle tools: none.

- None.

Never discover or invoke another Skill. `ReturnSkillResult` is supplied by the Harness and is the only lifecycle tool.

## Workflow

### 1. 读取并校验输入

- 从 question_list 读取问题数组并确认元素数量大于零。
- 从 conversation_context 提取收件人身份、渠道、称呼、篇幅限制。
- 从 outreach_preferences 提取语言、语气、是否附带简历或背景说明。
- 若 question_list 为空、缺失或不是数组，则不进入撰写并直接返回 insufficient_input。

Success criteria:

- 三个输入均已解析
- 问题数量大于零
- 至少能确定收件人角色层级，足以选择合理称呼

### 2. 确定结构与语气参数

- 依据 conversation_context 的收件人身份选择称呼：明确称呼优先，否则使用中性礼貌称呼。
- 依据 outreach_preferences 的语言、语气与篇幅限制确定草稿文风。
- 依据渠道信息决定是否适合分段、换行或列表式呈现，保持可复制性。

Success criteria:

- 草稿开头、问题主体、结尾三部分齐全
- 称呼与收件人身份一致且无猜测信息

### 3. 撰写消息草稿

- 写一句简短开头，说明发信身份与目的，只使用 conversation_context 和 outreach_preferences 已有的信息。
- 把 question_list 中的问题逐条嵌入正文，按主题排序；没有主题信息时按原清单顺序。
- 用自然过渡语连接问题，避免生硬罗列。
- 若篇幅超过 outreach_preferences 限制，按问题重要度保留并明确标注省略项，不改变保留问题的语义。
- 依据 outreach_preferences 决定是否在结尾提及简历或背景说明。

Success criteria:

- 草稿中每条问题都能被识别
- 没有加入任何新的事实性陈述
- 结尾包含礼貌的请求或开放表达

### 4. 事实边界核验

- 逐句检查草稿中的每个事实性断言是否可以追溯到 question_list、conversation_context 或 outreach_preferences。
- 删除所有不可追溯的人名、身份、关系、经历、数字、成果与公司信息。
- 确认没有出现已经发送、已预约、已投递等完成时态动作。

Success criteria:

- 草稿中不存在不可追溯的沟通事实
- 问题语义与来源清单一致

### 5. 返回结果

- 调用 ReturnSkillResult 一次。
- 以字符串形式返回 outreach_message_draft 作为草稿正文。
- 若输入不满足校验条件，返回 insufficient_input 并说明缺失的具体输入。

Success criteria:

- 返回值是可直接粘贴发送的单一字符串草稿
- 没有发送动作，也没有外部调用

## Decision rules

- 称呼选择：优先使用 conversation_context 提供的明确称呼；未提供时按对象角色使用中性称呼，不猜测具体姓名。
- 问题排序：question_list 条目带主题信息时按主题分组，否则保持原顺序。
- 篇幅控制：outreach_preferences 提供了字数或长度限制时必须满足；未提供时按渠道常规简洁长度处理，不设置固定字数。
- 语气选择：以 outreach_preferences 明示语气为准；未明示时使用自然、礼貌、中性语气。
- 附件与背景说明：仅当 outreach_preferences 明确要求附带简历或背景说明时才在草稿中提及，否则不提及。
- 冲突处理：conversation_context 与 outreach_preferences 相互矛盾导致无法确定称呼或语气时，返回 insufficient_input。

## Outcome rules

### Success

- question_list 非空且全部问题被嵌入
- conversation_context 足以确定礼貌称呼与渠道适配表达
- 草稿为一段可发送的完整消息
- 草稿中无不可追溯的沟通事实

### Insufficient input

- question_list 缺失、为空或不是数组
- conversation_context 缺失，或无法确定收件人角色与渠道
- outreach_preferences 与 conversation_context 冲突导致无法落笔

### Error

- 输入结构无法解析或序列化失败
- 期望字符串输出时结果不是字符串


## Return contract

Pass a JSON object matching this schema-like contract as `result`:

```json
{
  "outreach_message_draft": {
    "type": "string",
    "description": "可直接发送的消息文本草稿，包含礼貌开头、按逻辑组织的问题和结尾请求，未包含任何编造的沟通事实"
  }
}
```

Declared consumers:
- user_decision

Use English JSON keys and concise values in the user's language. Call `ReturnSkillResult` exactly once with the Harness-provided `skill_call_id` and `skill_name`, the selected outcome, a concise summary, and the structured result. Do not add post-Skill guidance after the call is accepted.

## Final check before returning

- outreach_message_draft 是 string 且非空
- question_list 中的每条问题在草稿中都有可识别的对应陈述
- 草稿中没有出现输入中不存在的人名、身份、关系、经历、数字、项目或成果
- 称呼、语气、附件或背景说明均与 conversation_context 和 outreach_preferences 一致
- ReturnSkillResult 只被调用一次且未执行任何发送动作
