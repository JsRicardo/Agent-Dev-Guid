# 7 · Agent 的 Search 工具如何实现

> 章节：第二章 Tool System

## 本讲目标

实现一套联网检索工具：并发执行多条查询、按网址去重、把结果按标识保存以便后续取回、把网页正文提取成可读文本。这一讲结束时，Agent 能查证需要近期信息的问题并给出带链接来源的结论。

## 要写的代码

```
src/tools/search/
├── providers.ts       各家检索服务的适配
├── search.ts          web_search 工具
├── fetch.ts           get_search_content 工具
├── store.ts           结果存储
└── index.ts           注册
```

### 结果存储

```typescript
type StoredResult = {
  responseId: string;
  query: string;
  results: Array<{ title: string; url: string; snippet: string }>;
  content: Map<string, string>;
  createdAt: number;
};

const store = new Map<string, StoredResult>();
const TTL_MS = 60 * 60 * 1000;

export function put(result: Omit<StoredResult, "responseId" | "createdAt">): string {
  const responseId = randomUUID();
  store.set(responseId, { ...result, responseId, createdAt: Date.now() });
  return responseId;
}

export function get(responseId: string): StoredResult | undefined {
  const entry = store.get(responseId);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > TTL_MS) {
    store.delete(responseId);
    return undefined;
  }
  return entry;
}
```

检索结果整体保留在程序内存里，模型只拿到摘要与链接。需要正文时用标识取回，这样上下文占用可控，正文的抓取也可以按需进行。

### 检索服务的适配

```typescript
export type SearchHit = { title: string; url: string; snippet: string };

export type Provider = {
  name: string;
  search: (input: { query: string; numResults: number; signal?: AbortSignal }) => Promise<SearchHit[]>;
};

const providers = new Map<string, Provider>();

export function registerProvider(provider: Provider): void {
  providers.set(provider.name, provider);
}

export async function searchWith(
  name: string,
  input: { query: string; numResults: number; signal?: AbortSignal },
): Promise<SearchHit[]> {
  const provider = providers.get(name);
  if (!provider) throw new Error(`没有配置检索服务 ${name}`);
  return provider.search(input);
}
```

每接一家服务写一个适配文件，导出一个 `Provider`。切换服务只改配置，不改工具定义。

### web_search

```typescript
import { registerTool, type ToolContext, type ToolResult } from "../registry.ts";
import { searchWith } from "./providers.ts";
import { put } from "./store.ts";

const MAX_CONCURRENT_QUERIES = 3;

export function registerWebSearchTool(defaultProvider: string): void {
  registerTool({
    name: "web_search",
    description:
      "联网检索。一次可以给出多条角度不同的查询，最多三条并发执行。返回带链接的结果摘要，完整结果按 responseId 保存，需要正文时用 get_search_content 取回。",
    snippet: "联网检索，优先使用 queries 数组给出两到四个不同角度",
    guidelines: [
      "研究类问题用 queries 给出多个角度不同的查询，不要用换词重述同一个角度",
      "结论必须带链接来源",
    ],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "单条查询" },
        queries: {
          type: "array",
          items: { type: "string" },
          description: "多条查询，最多三条并发执行",
        },
        numResults: { type: "number", description: "每条查询返回多少条结果，默认 5，上限 20" },
        recencyFilter: { type: "string", enum: ["day", "week", "month", "year"], description: "按时间范围过滤" },
        domainFilter: { type: "array", items: { type: "string" }, description: "限定或排除域名，前缀加减号表示排除" },
        provider: { type: "string", description: "指定检索服务，省略时使用默认配置" },
      },
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const queries = normalize(args, ctx);
      if (queries.length === 0) {
        return { content: "没有给出查询内容", isError: true };
      }

      const providerName = args.provider ?? defaultProvider;
      const batches: string[][] = [];
      for (let i = 0; i < queries.length; i += MAX_CONCURRENT_QUERIES) {
        batches.push(queries.slice(i, i + MAX_CONCURRENT_QUERIES));
      }

      const collected: Array<{ query: string; hits: SearchHit[] }> = [];
      for (const batch of batches) {
        const settled = await Promise.all(
          batch.map(async (query) => ({
            query,
            hits: await searchWith(providerName, {
              query,
              numResults: args.numResults ?? 5,
              signal: ctx.signal,
            }),
          })),
        );
        collected.push(...settled);
      }

      const responseId = put({
        query: queries.join(" | "),
        results: dedupe(collected.flatMap((item) => item.hits)),
        content: new Map(),
      });

      return {
        content: render(responseId, collected),
        details: { responseId, providers: [providerName], queryCount: queries.length },
      };
    },
  });
}

function normalize(args: Record<string, unknown>, ctx: ToolContext): string[] {
  const list = Array.isArray(args.queries)
    ? (args.queries as string[])
    : typeof args.query === "string"
      ? [args.query]
      : [];
  return [...new Set(list.map((item) => item.trim()).filter(Boolean))];
}

function dedupe(hits: SearchHit[]): SearchHit[] {
  const seen = new Map<string, SearchHit>();
  for (const hit of hits) {
    const key = normalizeUrl(hit.url);
    if (!seen.has(key)) seen.set(key, hit);
  }
  return [...seen.values()];
}

function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (key.startsWith("utm_") || key === "ref" || key === "source") {
      parsed.searchParams.delete(key);
    }
  }
  return parsed.toString().replace(/\/$/, "");
}

function render(responseId: string, collected: Array<{ query: string; hits: SearchHit[] }>): string {
  const parts = [`responseId: ${responseId}`];
  for (const item of collected) {
    parts.push(`\n## 查询：${item.query}`);
    if (item.hits.length === 0) {
      parts.push("没有返回结果");
      continue;
    }
    for (const hit of item.hits) {
      parts.push(`- ${hit.title}\n  ${hit.url}\n  ${hit.snippet}`);
    }
  }
  return parts.join("\n");
}
```

去重要处理网址的常见差异：末尾斜杠、片段标识、跟踪参数。不处理的后果是同一页面在结果里出现三次，占用上下文。

### get_search_content

```typescript
export function registerFetchContentTool(): void {
  registerTool({
    name: "get_search_content",
    description: "取回上一次检索保存的完整内容，或用 prompt 让模型基于指定网页回答一个问题。",
    snippet: "取回检索结果的正文内容",
    parameters: {
      type: "object",
      properties: {
        responseId: { type: "string", description: "检索返回的标识" },
        url: { type: "string", description: "只取回某一个网址的内容" },
        urlIndex: { type: "number", description: "按序号取回某一条结果" },
        prompt: { type: "string", description: "针对该网页提出的问题，只使用该网页内容回答" },
        limit: { type: "number", description: "返回的字符数上限" },
      },
      required: ["responseId"],
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const stored = get(args.responseId);
      if (!stored) {
        return { content: "该标识对应的结果已过期，请重新检索", isError: true };
      }
      const target = pick(stored, args);
      if (!target) {
        return { content: "没有找到对应的结果", isError: true };
      }

      const cached = stored.content.get(target.url);
      const text = cached ?? (await extract(target.url, ctx.signal));
      stored.content.set(target.url, text);

      if (args.prompt) {
        const answer = await answerWithText(args.prompt, text, ctx.signal);
        return { content: answer, details: { url: target.url, mode: "answer" } };
      }

      const bounded = text.slice(0, args.limit ?? 20_000);
      return {
        content: `来源：${target.url}\n\n${bounded}${text.length > bounded.length ? "\n\n[内容已截断]" : ""}`,
        details: { url: target.url, truncated: text.length > bounded.length },
      };
    },
  });
}
```

正文提取优先使用可读性抽取，把导航、广告、脚本去掉，只保留正文。抓取一次之后写进 `stored.content`，同一次检索里重复取回同一网址不再发起请求。

## pi 的做法

**服务适配的规模。** `pi-web-access` 为每一家检索服务写一个文件，目录里有三十多个适配文件，覆盖通用检索、专用检索、学术与代码检索等类别。适配层还包含凭据读取（`credential-source.ts`）、浏览器 Cookie 读取（`chrome-cookies.ts`）与代理配置。

**默认工作流。** 工具描述里明确写了默认不生成摘要，只返回带链接的结果，并说明结果按 `responseId` 保存。摘要生成是可选步骤：

```
The default workflow is none: it returns bounded source-linked search results or
provider answers without a curator or generated summary, identifies the providers
used, and stores full results for retrieval by responseId.
```

讲义里同样把摘要生成留给后续步骤，检索工具只负责取回与呈现。

**查询写法被写进描述。** pi 在工具描述里直接给出示例并解释取舍：

```
Prefer {queries:[...]} with 2-4 varied angles over a single query for broader coverage.
Good: ['React vs Vue performance benchmarks 2026', 'React vs Vue developer experience comparison', ...]
Bad: ['React vs Vue', 'React vs Vue comparison', 'React vs Vue review'] (too similar, redundant results)
```

正面例子与反面例子同时给出，比只说「给出角度不同的查询」效果明显。

**并发上限。** pi 的查询数组一次最多执行三条，讲义里的 `MAX_CONCURRENT_QUERIES` 与之相同。上限的作用是避免同时对多个服务发出大量请求。

**代理与出站路径。** pi 提供一个 `proxy` 参数，并说明 Node 的 fetch 不会读取 `HTTP(S)_PROXY` 环境变量，因此需要显式传入。这一处在国内网络环境下经常用到。

**查询改写。** `query-rewrite.ts` 负责把一条长问题改成适合检索的形式。这一层是可选的，讲义里留给读者按需要补充。

## 验收

1. 提问一个需要近期信息的问题，工具调用里应当出现多条角度不同的查询，返回结果里网址不重复。
2. 让 Agent 引用某一条结果的正文，`get_search_content` 应当返回该网址的内容，第二次取回同一网址时不再发起网络请求。
3. 把检索服务的密钥置空，工具应当返回明确的失败说明，模型据此说明缺少检索能力，不继续推断。

## 常见错误

第一个错误是不按网址去重。同一页面重复出现会占用上下文并让来源看起来比实际更多。

第二个错误是把正文直接放进检索结果。检索一次可能返回十条结果，每条的正文都放进去会一次性占满预算。

第三个错误是把结果只保留在返回文本里。没有标识与存储，模型无法在后续轮次取回正文。

第四个错误是忽略过期。结果存储需要存活时间，长期保留会让内存持续增长。

第五个错误是工具描述不给出查询写法示例。模型默认会用换词重述的方式给出多条查询，覆盖度没有提升。