# Object Relation Skill Pipeline

这是一条位于 `skilltool-synthesis-lab` 内的独立实验管线：

```text
自然语言画像 / 场景
  → 初始任务池 P0
  → 每个任务的隐藏 m→n 信息关系
  → 全局 Object Set 聚类去重
  → 可复现的随机 / 受约束 k→1 采样
  → P1 任务生成与合理性验证
  → 每个 P1 任务生成一个 Skill
```

P0 初始化直接复用上一级目录现有的 `SynthesisPipeline` 初始化逻辑；最终 Skill 候选生成、任务契约归一、直接校验和文件渲染也直接复用现有 Skill 生成管线。中间关系管线使用本目录自己的 Prompt、数据结构、stage 实现和运行记录。

P1 验证只检查关系忠实度、输入充分性、输出可推导性、场景一致性、自然用户表达、业务价值及安全边界；不会与 P0 做重复性比较，也不会因为 P1 与 P0 相似而拒绝任务。

## 阶段

| 阶段 | 文件 | 作用 |
|---|---|---|
| `stage1_1` | `pipeline/stage1_1_input_validation.py` | 复用确定性输入检查，失败即阻断 |
| `stage1_2` | `pipeline/stage1_2_p0_task_synthesis.py` | 复用现有初始化 Prompt 和 P0 任务生成 |
| `stage2_1` | `pipeline/stage2_1_relation_extraction.py` | 逐 P0 任务调用 LLM 抽取 m→n 信息关系 |
| `stage2_2` | `pipeline/stage2_2_object_clustering.py` | LLM 语义聚类；确定性层只校验分区、补齐漏项、拆分类型并按聚类证据投影关系，不使用名称等硬编码规则判重 |
| `stage3_1` | `pipeline/stage3_1_relation_sampling.py` | 固定 seed 的 random/constrained k→1 采样 |
| `stage3_2` | `pipeline/stage3_2_p1_task_generation.py` | 逐关系调用 LLM 生成 P1 任务并强制归一契约 |
| `stage3_3` | `pipeline/stage3_3_p1_task_validation.py` | 确定性 + LLM 评审，不比较 P0 |
| `stage4_1` | `pipeline/stage4_1_skill_generation.py` | 复用现有逐任务 Skill 候选生成 |
| `stage4_2` | `pipeline/stage4_2_artifact_finalization.py` | 复用现有直接校验和产物渲染，并在落盘前阻断内部元数据向运行时契约泄漏 |

`task_id`、`p1_task_id`、`relation_contract`、relation/object/mention ID、采样字段和 provenance 等只用于设计期追踪，不属于任务的信息对象或 Skill 运行时输入。Stage 4 会在调用既有 Skill 生成器前移除这些内部字段，并通过专用 Prompt 约束禁止它们进入 `input_schema`、工作流变量和用户可见文本。

最终校验报告保存在 `stages/stage4_2_artifact_finalization/runtime-metadata-validation.json`。报告按 Skill 和 JSON path 列出命中的内部字段；存在任何违规时 Stage 4.2 失败，Skill 不会写入 `generated-skills`。顶层 `task_ids`、独立 `relation_contract` 及 Skill/Tool 自身标识属于非运行时追踪或调用身份，不作为输入泄漏处理。

新 Prompt 集中在 `pipeline/prompts.py`，包括关系抽取、对象聚类、P1 任务生成和 P1 验证的完整提示词。

## 完整运行

无需第三方依赖，使用 Python 3.10+：

```powershell
cd skilltool-synthesis-lab/object_relation_pipeline
py -3 run_pipeline.py --mode mock
```

API 模式读取上一级 `data/model_config.local.json`，或显式指定配置：

```powershell
py -3 run_pipeline.py --mode api --config ../data/model_config.local.json
```

采样参数：

```powershell
py -3 run_pipeline.py `
  --seed 20260827 `
  --target-count 8 `
  --candidate-multiplier 3 `
  --k-min 1 `
  --k-max 3 `
  --sampling-mode constrained
```

## 区间运行

先运行到 Object Set：

```powershell
py -3 run_pipeline.py --to-stage stage2_2
```

命令会返回 `run_id`。随后从采样继续到 P1 验证：

```powershell
py -3 run_pipeline.py `
  --run-id <run-id> `
  --from-stage stage3_1 `
  --to-stage stage3_3
```

最后生成 Skill：

```powershell
py -3 run_pipeline.py `
  --run-id <run-id> `
  --from-stage stage4_1 `
  --to-stage stage4_2
```

阶段参数既可以使用完整名称，也可以使用唯一前缀，例如 `stage2_1`。

## 独立运行单个阶段

第一阶段可以直接创建新运行：

```powershell
py -3 run_stage.py --stage stage1_1 --mode mock
```

后续阶段需要已有 run：

```powershell
py -3 run_stage.py --run-id <run-id> --stage stage1_2
py -3 run_stage.py --run-id <run-id> --stage stage2_1
```

每个阶段只在全部前置阶段完成后运行。已完成阶段默认跳过；如需不同配置重新实验，建议创建新 run，避免下游状态与新配置混用。

## Web UI

```powershell
py -3 server.py
```

打开 <http://127.0.0.1:8791>。页面支持：

- 编辑画像和场景；
- 选择模型、起止阶段和采样参数；
- 在 API 模式配置 `temperature`、`max_tokens` 和请求超时时间；其中任务池与 Skill 生成阶段的代码上限为 48000 tokens，实际值还受模型服务限制；
- 查看历史运行；
- 查看 P0、m→n 标签、Object Set、k→1 关系、P1 验证结果和 Skill 文件。

## 阶段产物

每个阶段都会保存：

```text
runs/<run-id>/stages/<stage-name>/
  stage.json
  input.json
  output.json
  trace.json
  ...阶段专属文件
```

模型驱动的逐项阶段还会保存每个任务或关系的 Prompt、模型 trace、解析结果和规范化结果。最终 Skill 位于：

```text
runs/<run-id>/generated-skills/<skill-name>/
```

根状态保存在 `runs/<run-id>/run.json`，`stage-manifest.json` 提供阶段索引。

## 测试

```powershell
py -3 -m unittest discover -s tests -v
```
