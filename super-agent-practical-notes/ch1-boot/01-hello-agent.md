# 1 · 10 分钟，让你的 AI 开口说话

> 章节：第一章 起步 + Agent Loop

## 本讲目标

跑通一次模型调用，并把返回内容按片段打印到终端。这一讲不涉及工具与循环，目标是把模型调用这一层的形状固定下来：请求怎么构造、事件怎么读、用量怎么取。

## 要写的代码

```
super-agent/
├── package.json
├── tsconfig.json
└── src/
    ├── model.ts        模型层：请求与事件
    └── cli.ts          入口：读参数、打印片段
```

`package.json`：

```json
{
  "name": "super-agent",
  "type": "module",
  "scripts": { "dev": "node --experimental-strip-types src/cli.ts" },
  "dependencies": {
    "@ai-sdk/openai": "^2.0.0",
    "ai": "^5.0.0"
  }
}
```

`src/model.ts` 把模型调用收在一处，后面每一讲都通过它调用模型。

```typescript
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";

export type ModelEvent =
  | { type: "text"; delta: string }
  | { type: "usage"; input: number; output: number };

export async function* streamModel(input: {
  system?: string;
  prompt: string;
  signal?: AbortSignal;
}): AsyncGenerator<ModelEvent> {
  const result = streamText({
    model: openai("gpt-4.1-mini"),
    system: input.system,
    prompt: input.prompt,
    abortSignal: input.signal,
  });

  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      yield { type: "text", delta: part.text };
    }
  }

  const usage = await result.usage;
  yield {
    type: "usage",
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
  };
}
```

`src/cli.ts`：

```typescript
import { streamModel } from "./model.ts";

const prompt = process.argv.slice(2).join(" ");
if (!prompt) {
  console.error("用法：npm run dev -- <问题>");
  process.exit(1);
}

for await (const event of streamModel({ prompt })) {
  if (event.type === "text") {
    process.stdout.write(event.delta);
  } else {
    process.stdout.write(
      `\n\n[用量] 输入 ${event.input} 输出 ${event.output}\n`,
    );
  }
}
```

运行：

```bash
npm install
npm run dev -- "用三句话说清楚什么是 Agent Loop"
```

## pi 的做法

pi 把模型调用层单独做成一个包，叫 `pi-ai`，位置在：

```
node_modules/@earendil-works/pi-ai/dist
```

它与上面 `model.ts` 的差别集中在四点。

**第一，事件类型更完整。** pi 的事件里除了文本片段，还有思考片段与工具调用片段。`pi-agent-core/dist/agent-loop.js` 里对事件的 `switch` 列出了完整集合：

```typescript
case "text_start":
case "text_delta":
case "text_end":
case "thinking_start":
case "thinking_delta":
case "thinking_end":
case "toolcall_start":
case "toolcall_delta":
case "toolcall_end":
```

工具调用的参数以片段形式到达，`toolcall_delta` 携带的是当前累积后的部分结果，由 `pi-ai` 完成拼接。讲义里的最小实现在第 4 讲展开工具之后也需要补上这一类事件。

**第二，用量分成四项。** pi 的用量结构是 `input`、`output`、`cacheRead`、`cacheWrite`，另有 `reasoning` 与成本字段。上面的最小实现只有输入与输出两项，第 13 讲讨论成本时会用到另外两项。

**第三，调用函数做成了参数。** `agentLoop(prompts, context, config, signal, streamFn)` 里的 `streamFn` 是一个参数，默认取 `getDefaultStreamFn()`。这样做的好处是测试与替换供应方都不需要改动循环代码，讲义里的实现也应当把模型调用做成可替换的依赖。

**第四，请求形状需要归一化。** 发出请求之前 pi 会走三步：

```typescript
const llmMessages = await config.convertToLlm(messages);
const llmContext = normalizeContext({ messages: llmMessages });
const response = await streamFunction(config.model, llmContext, options);
```

内部消息类型比供应方支持的形态丰富，转换集中在一处。最小实现直接从字符串构造请求，第 10 讲引入会话之后同样需要这一层转换。

**关于自己写模型层还是用现成库。** pi 选择自己写，原因是需要按错误文本判断可重试性、需要统一各家的事件与用量字段、需要在压缩与缓存续期这类内部调用上单独控制参数。讲义里先用现成库，等到第 3 讲需要按错误文本分类重试、第 13 讲需要缓存读写用量时，再补一层薄的包装即可。

## 验收

1. 运行 `npm run dev -- "用三句话说清楚什么是 Agent Loop"`，文字应当逐渐出现；等待几秒后一次性出现说明流式没有生效。
2. 结尾打印出输入与输出 Token 数量，两个数字都不为零。
3. 把网络断开后再运行一次，程序应当报错退出，不应静默结束。

## 常见错误

第一个错误是把流式片段拼成一个字符串再打印。这样做的结果是等全部生成完毕才看到输出，首字延迟的收益全部丢失。

第二个错误是只用 `text` 属性。部分供应方在生成结束时会给出完整文本事件，与片段事件重复，需要按事件类型区分，否则文字会重复出现。

第三个错误是把 API 密钥写入代码。密钥走环境变量，代码里只引用变量名。

第四个错误是没有把模型调用收在一处。后面每一讲都要改这一层，散在各处的调用会反复修改。

第五个错误是忽略用量。没有用量就没有预算控制，第 3 讲的 Token 预算无从实现。