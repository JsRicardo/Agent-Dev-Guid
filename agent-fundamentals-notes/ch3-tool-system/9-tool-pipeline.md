# 9 · 一次工具调用的完整过程

> 章节：第三章 Tool System

## 生产中会遇到的问题

模型返回了一个工具调用，程序执行之后把结果交回去，模型却在下一轮重复调用同一个工具。出现这种情况的原因通常在结果处理环节：结果被截断得太多、格式不可读、错误信息缺失，模型无法从中得到新的信息。

## 底层机制

一次完整的工具调用经过的环节如下。

```mermaid
graph LR
  A["模型输出调用内容"] --> B["解析与校验参数"]
  B --> C["前置 Hook"]
  C --> D["执行"]
  D --> E["后置 Hook"]
  E --> F["结果截断与整理"]
  F --> G["写回消息数组"]
```

每个环节都有明确的职责，遗漏任一环节都会在后续暴露。其中最容易被简化的是结果处理，它同时影响效果与成本。

**长度截断。** 读取文件保留开头，执行命令保留结尾。错误信息常出现在末尾，只保留头部会让模型看不到失败原因。

**格式整理。** 加入行号、文件路径、是否被截断的标记。模型引用内容时依赖行号。

**信息补充。** 说明本次输出的范围，例如「该目录共有 128 个文件，以下列出前 50 个」。缺少这句话时模型会认为列表就是全部内容。

**超大输出的替代。** 把内容写入文件，返回摘要与路径，模型需要细节时再读取。

## 实现要点

并发控制的实现方式是把调用分成两组，只读工具并发执行，写入工具按顺序执行。

```typescript
const parallel = calls.filter((c) => READ_ONLY.has(c.name));
const sequential = calls.filter((c) => !READ_ONLY.has(c.name));

const results = [...(await Promise.all(parallel.map(run))), ...(await runInOrder(sequential))];
```

结果写回的顺序必须与调用顺序一致，即使执行是并发的。顺序错位会让模型把结果与调用对应错误。

错误结果应当写成给人看的文字。附带建议的写法能显著减少重试次数。

## pi 的做法

`pi-agent-core/dist/agent-loop.js` 把一次调用分成三个阶段，每个阶段都有独立的扩展点。

**阶段一：`prepareToolCall`。**

- 找不到工具名时直接返回 `Tool <名称> not found` 的错误结果。
- 调用工具的 `prepareArguments` 做参数预处理。
- 用 `validateToolArguments` 校验参数，校验失败把错误文本作为结果返回，不执行。
- 调用 `config.beforeToolCall`，返回 `block` 时终止执行，`block` 里的 `reason` 成为模型看到的错误内容；`terminate: true` 可以连整个运行一起结束。

**阶段二：`executePreparedToolCall`。** 执行工具体，并把工具的进度回调转成 `tool_execution_update` 事件。这样长耗时工具可以在执行过程中持续汇报。

**阶段三：`finalizeExecutedToolCall`。** 调用 `config.afterToolCall`，可以改写 `content`、`details`、`usage`、`terminate`，也可以改变 `isError`。这一步是审计与结果加工的插入位置。

并发策略由工具自身的 `executionMode` 决定：

```typescript
const hasSequentialToolCall = toolCalls.some(
  (tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
);
if (config.toolExecution === "sequential" || hasSequentialToolCall) {
  return executeToolCallsSequential(...);
}
return executeToolCallsParallel(...);
```

只要批次里有任意一个工具声明为顺序执行，整批就转为顺序执行。并发批次内部用 `Promise.all` 收结果，然后按调用顺序生成结果消息。

写入冲突的处理位置在工具内部。`dist/core/tools/file-mutation-queue.js` 的 `withFileMutationQueue` 按文件的真实路径建立队列，同一个文件的操作串行，不同文件的操作并行。队列键用 `realpath` 解析，符号链接指向同一文件时也会进入同一个队列。

截断策略由 `dist/core/tools/truncate.js` 提供两个方向的函数：

| 函数 | 保留位置 | 使用场景 |
|------|----------|----------|
| `truncateHead` | 开头 | 读取文件，需要看到起始内容 |
| `truncateTail` | 结尾 | 执行命令，需要看到错误与最终结果 |

两者都按行数与字节数双限判断，都不会返回不完整的行。行数上限 2000，字节上限 50KB。`truncateHead` 在首行就超出字节上限时返回空内容并置 `firstLineExceedsLimit`，读取工具据此提示模型改用命令行方式查看。

## 常见错误

第一个错误是把原始对象序列化之后作为结果。JSON 字符串占用 Token 多且可读性差。

第二个错误是截断时不标注。模型看不到省略标记时会以为内容完整。

第三个错误是并发执行写入工具。两个文件同时被写入时，结果取决于执行顺序。

第四个错误是权限拒绝时返回空结果。模型看不到拒绝理由，会继续尝试其他绕过方式。

第五个错误是把校验与执行混在一起。参数校验失败时不应该产生任何副作用。

## 自检问题

1. 你的工具结果里有截断标记与总长度说明吗？
2. 并发执行的结果写回顺序与调用顺序一致吗？
3. 同一个文件的并发写入是怎么串行化的？
4. 参数校验失败发生在执行之前吗？