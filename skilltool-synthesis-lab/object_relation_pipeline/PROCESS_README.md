# 实现与数据契约

## 信息对象定义

Object 是一个可复用的信息语义契约，不是具体值，也不是动作。规范对象至少包含：

```json
{
  "object_id": "obj_*",
  "name": "snake_case",
  "display_name": "自然语言名称",
  "description": "稳定信息语义",
  "type": "object|array|string|number|boolean",
  "member_mention_ids": [],
  "role_statistics": {"input": 0, "output": 0},
  "acquisition_options": [],
  "provenance": []
}
```

`stage2_1` 中每个 P0 任务产生：

```text
t([I_0, ..., I_(m-1)], [O_0, ..., O_(n-1)])
```

`stage3_1` 采样：

```text
t([I_0, ..., I_(k-1)], O)
```

输入顺序不改变关系签名，因此 relation signature 会对输入 ID 排序。

## Prompt 边界

`pipeline/prompts.py` 是中间关系阶段 Prompt 的唯一来源：

- `relation_extraction_prompt`：区分任务前必需信息、任务后新增信息和内部步骤。
- `object_clustering_prompt`：按信息语义聚类，不按 I/O 角色或同一关系内的位置隔离；名称和类型相同不能单独作为合并依据。确定性层只投影 LLM 已确认的语义簇，并在 `relation-semantic-projections.json` 保存同一关系内的合并证据。
- `p1_generation_prompt`：只能使用采样的 k 个输入并产生唯一输出；关系不成立时允许返回不可实现。
- `p1_validation_prompt`：明确禁止比较 P0，只评审关系本身和场景合理性。

所有关系类 Prompt 都把 `task_id`、`p1_task_id`、`relation_contract`、relation/object/mention ID、采样参数、标签、溯源和阶段字段定义为设计期控制元数据，禁止将其生成为信息对象、运行时输入输出、用户问法或工作流变量。Stage 4 在复用原 Skill 生成管线前还会构造仅含业务语义的任务视图，内部关系契约在模型生成完成后再作为独立追踪信息附加。

Stage 4.2 在最终产物写盘前执行 `validate_runtime_metadata_boundaries`，递归检查候选的输入输出契约、组合字段、工作流、行动工具、评测样例及用户可见文本。若命中 P0/P1 任务引用、relation/object/mention ID、采样字段或阶段标识，流水线阻断；详细命中位置写入 `runtime-metadata-validation.json`。在此之前，Stage 4.1 已将任务依赖中的内部 P1 task 引用映射为对应 Skill 名称。

模型结果始终经过代码规范化，最终 P1 的输入输出由采样关系决定，而不是由模型自由修改。

## 复用边界

允许直接复用的现有实现只有两端：

1. P0：`../pipeline/synthesis.py::SynthesisPipeline` 的输入检查和初始化任务池。
2. Skill：同一个 `SynthesisPipeline` 的逐任务 `candidate_synthesis`，以及 `../pipeline/direct_synthesis.py::finalize_direct_result`。

关系抽取、聚类、采样、P1 生成、P1 验证、运行状态、CLI 和 Web 服务均在本目录独立实现。

## 可复现性

关系采样使用 `random.Random(seed)`。在 Object Set、seed、k 范围、采样模式和候选数量相同时，关系签名顺序确定。

LLM 阶段仍受模型版本、temperature 和服务端实现影响；每次实际 Prompt、请求和响应都保存在阶段目录中。
