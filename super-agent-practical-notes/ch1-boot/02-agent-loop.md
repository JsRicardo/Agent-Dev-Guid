# 2 · 从能聊天到能干活：给 Agent 装上 while 循环

> 章节：第一章 起步 + Agent Loop

## 本讲目标

让模型能够要求调用工具，程序执行工具之后把结果交回模型，模型再继续。这一讲结束时，程序可以完成「读取一个文件并概括内容」这类需要多步的任务。

## 要写的代码

```
src/
├── model.ts              第 1 讲，本讲扩展
├── types.ts              消息与工具的类型
├── tools/
│   └── read.ts           第一个工具
└── agent/
    └── loop.ts           循环
```

`src/types.ts`：

```typescript
export type ToolCall = { id: string; name: string; args: unknown };

export type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; stopReason: StopReason }
  | { role: "toolResult"; callId: string; name: string; text: string; isError: boolean };

export type StopReason = "stop" | "toolCalls" | "length" | "error" | "aborted";
```

把 `stopReason` 明确写进类型是这一讲最重要的决定。第 3 讲的预算与容错、第 5 讲的截断处理都要读这个字段。

`src/tools/read.ts`：

```typescript
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolCall } from "../types.ts";

export const readTool = {
  name: "read",
  description:
    "读取文件内容，返回带行号的文本。输出被截断到 2000 行或 50KB，谁先命中按谁处理；需要后续内容时用 offset 继续读取。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径，可以是相对路径或绝对路径" },
      offset: { type: "number", description: "从第几行开始读取，从 1 开始计数" },
      limit: { type: "number", description: "最多读取多少行" },
    },
    required: ["path"],
  },
};

export async function executeRead(call: ToolCall, cwd: string): Promise<string> {
  const args = call.args as { path: string; offset?: number; limit?: number };
  const buffer = await readFile(resolve(cwd, args.path));
  const lines = buffer.toString("utf-8").split("\n");
  const start = args.offset ? Math.max(0, args.offset - 1) : 0;
  if (start >= lines.length) {
    throw new Error(
      `offset ${args.offset} 超出文件末尾，该文件共 ${lines.length} 行`,
    );
  }
  const end = args.limit ? Math.min(start + args.limit, lines.length) : lines.length;
  return lines
    .slice(start, end)
    .map((line, index) => `${String(start + index + 1).padStart(5)} | ${line}`)
    .join("\n");
}
```

`src/agent/loop.ts`：

```typescript
import type { Message, ToolCall } from "../types.ts";
import { readTool, executeRead } from "../tools/read.ts";

const MAX_STEPS = 20;
const registry = [readTool];

export async function runAgent(input: {
  prompt: string;
  cwd: string;
  onText: (delta: string) => void;
  onToolStart: (call: ToolCall) => void;
  onUsage?: (input: number, output: number) => void;
  signal?: AbortSignal;
}): Promise<{ messages: Message[]; stopReason: string }> {
  const messages: Message[] = [{ role: "user", text: input.prompt }];

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await callModel(messages, registry, input.signal);
    messages.push(response);

    if (response.stopReason === "error" || response.stopReason === "aborted") {
      return { messages, stopReason: response.stopReason };
    }

    if (response.stopReason !== "toolCalls") {
      return { messages, stopReason: response.stopReason };
    }

    for (const call of response.toolCalls) {
      input.onToolStart(call);
      const result = await runOne(call, input.cwd);
      messages.push({
        role: "toolResult",
        callId: call.id,
        name: call.name,
        text: result.text,
        isError: result.isError,
      });
    }
  }

  return { messages, stopReason: "stepLimit" };
}

async function runOne(call: ToolCall, cwd: string) {
  const tool = registry.find((item) => item.name === call.name);
  if (!tool) {
    return { text: `找不到工具 ${call.name}`, isError: true };
  }
  try {
    return { text: await executeRead(call, cwd), isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: `读取失败：${message}`, isError: true };
  }
}
```

`callModel` 的实现把消息数组、工具定义转成模型请求，把响应转回内部消息结构。事件里的文本片段仍然通过 `onText` 交给界面，这一层与第 1 讲相同。

## pi 的做法

`pi-agent-core/dist/agent-loop.js` 的 `runLoop` 与上面的循环形状相同，另外做了五件事。

**把两类插入消息区分开。** 内层循环每轮结束之后取一次 steering 消息，这类消息是使用者在运行中打进来的补充要求；外层循环在即将停止时检查 follow-up 消息，这类是已经排队的后续任务。讲义里的最小实现没有界面，可以先不做这一层，第 19 讲接入群聊之后需要补上。

**把准备阶段放在循环里。** 每一轮请求之前调用 `config.prepareRequest`，可以在这里替换上下文、模型与思考等级；每一轮开始之前调用 `config.prepareNextTurn`，压缩这类耗时操作放在这里完成。讲义里的压缩放在第 11 讲，届时需要一个与它对应的位置。

**工具执行分两种模式。** pi 按工具声明决定顺序或并发：

```typescript
const hasSequentialToolCall = toolCalls.some(
  (tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
);
if (config.toolExecution === "sequential" || hasSequentialToolCall) {
  return executeToolCallsSequential(...);
}
return executeToolCallsParallel(...);
```

只要一批调用里有一个工具声明为顺序执行，整批转为顺序执行。并发批次内部用 `Promise.all` 收结果，然后按调用顺序生成结果消息。

**工具结果与助手消息成对写入。** 助手消息里的工具调用与紧随其后的工具结果构成一组，写回顺序必须与调用顺序一致。

**输出被长度限制截断时整批判失败。** pi 检查 `stopReason === "length"`，此时所有工具调用的参数都可能不完整，因此一个都不执行：

```typescript
const executedToolBatch = message.stopReason === "length"
  ? await failToolCallsFromTruncatedMessage(toolCalls, emit)
  : await executeToolCalls(currentContext, message, config, signal, emit);
```

讲义里的最小实现也需要这个分支，否则会执行参数残缺的调用。

**循环结束时发出三类事件。** `turn_start`、`turn_end`、`agent_end` 供界面与观测使用。第 20 讲与第 24 讲会用到这些事件。

## 验收

1. 提问「读一下 package.json，说明 scripts 里有哪些命令」，程序应当先打印工具名称与参数，再打印基于文件内容的回答。
2. 提问中使用一个不存在的文件路径，模型应当看到读取失败的说明，并在下一轮改用正确的路径或直接回答找不到文件。
3. 打印每一轮提交给模型的消息条数，应当逐轮增长，最后一轮的消息条数等于用户消息加上助手与工具结果的组数。

## 常见错误

第一个错误是把工具结果拼进助手消息的文本里。工具结果需要是独立角色的消息，供应方与模型都依赖这个结构。

第二个错误是工具失败时中断整个循环。失败应当作为带错误标记的结果交回模型。

第三个错误是并发执行有先后依赖的工具。写入与读取有顺序关系，需要按模型给出的顺序执行。

第四个错误是结果写回顺序与调用顺序不一致。并发场景下按完成时间写回会导致对应关系错位。

第五个错误是没有轮数上限。重复调用同一个工具时程序不会停止，第 3 讲会补上完整的三道防线。