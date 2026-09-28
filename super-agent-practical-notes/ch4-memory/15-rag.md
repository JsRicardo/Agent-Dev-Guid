# 15 · 混合检索实战

> 章节：第四章 Memory + RAG

## 本讲目标

给记忆库与项目文档加上检索能力。这一讲结束时，程序同时维护关键词索引与向量索引，两路结果按排名融合之后重排，并且检索结果带来源与相关度。

## 要写的代码

```
src/memory/
├── index-db.ts      索引与存储
├── embed.ts         向量化
├── retrieve.ts      混合检索与融合
└── chunk.ts         分块
```

### 存储设计

两个索引放在同一个 SQLite 文件里：关键词用 FTS5，向量用 `sqlite-vec` 的虚拟表。

```typescript
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

export function openIndex(path: string) {
  const db = new Database(path);
  db.loadExtension(sqliteVec.getLoadablePath());

  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      heading TEXT,
      content TEXT NOT NULL,
      context TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      content, heading, source,
      content='chunks', content_rowid='id', tokenize='trigram'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding FLOAT[768]
    );
  `);

  return db;
}
```

三张表的职责：`chunks` 存原文与元数据；`chunks_fts` 是关键词索引，`tokenize='trigram'` 对中文更友好；`chunks_vec` 存向量。中文场景下 `trigram` 分词的效果通常优于默认分词器，因为不需要依赖词典。

### 分块与上下文化

`src/memory/chunk.ts`：

```typescript
export type Chunk = {
  source: string;
  heading: string;
  content: string;
  context: string;
};

const MAX_CHARS = 1200;
const OVERLAP_CHARS = 150;

export function chunkMarkdown(source: string, markdown: string): Chunk[] {
  const chunks: Chunk[] = [];
  const lines = markdown.split("\n");

  let heading = "";
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join("\n").trim();
    buffer = [];
    if (!text) return;
    for (const piece of splitByLength(text, MAX_CHARS, OVERLAP_CHARS)) {
      chunks.push({
        source,
        heading,
        content: piece,
        context: heading ? `${source} · ${heading}` : source,
      });
    }
  };

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) {
      flush();
      heading = match[2].trim();
      buffer.push(line);
      continue;
    }
    buffer.push(line);
  }
  flush();
  return chunks;
}

function splitByLength(text: string, maxChars: number, overlap: number): string[] {
  if (text.length <= maxChars) return [text];
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length);
    pieces.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - overlap;
  }
  return pieces;
}
```

两处设计要点：按标题切分，保留语义完整性，超长部分再按长度切并保留重叠；每个片段带上 `context` 字段，内容是「来源文件 · 章节标题」。这个字段参与向量化，让片段不再脱离语境。

### 向量化与写入

`src/memory/embed.ts`：

```typescript
const BATCH_SIZE = 64;

export async function embedAll(texts: string[]): Promise<number[][]> {
  const output: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: "text-embedding-3-small", input: batch }),
    });
    if (!response.ok) {
      throw new Error(`向量化失败：${response.status} ${await response.text()}`);
    }
    const payload = (await response.json()) as { data: Array<{ embedding: number[] }> };
    output.push(...payload.data.map((item) => item.embedding));
  }
  return output;
}
```

```typescript
export async function indexDocument(db: ReturnType<typeof openIndex>, source: string, markdown: string) {
  const chunks = chunkMarkdown(source, markdown);

  const insertChunk = db.prepare(
    "INSERT INTO chunks (source, heading, content, context, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  const insertFts = db.prepare("INSERT INTO chunks_fts (rowid, content, heading, source) VALUES (?, ?, ?, ?)");
  const insertVec = db.prepare("INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)");

  const embedInputs = chunks.map((chunk) => `${chunk.context}\n${chunk.content}`);
  const vectors = await embedAll(embedInputs);

  const write = db.transaction(() => {
    chunks.forEach((chunk, index) => {
      const info = insertChunk.run(chunk.source, chunk.heading, chunk.content, chunk.context, new Date().toISOString());
      const id = Number(info.lastInsertRowid);
      insertFts.run(id, chunk.content, chunk.heading, chunk.source);
      insertVec.run(id, new Float32Array(vectors[index]));
    });
  });
  write();
}
```

写入放在一个事务里，索引与原文保持一致。向量使用 `Float32Array` 传入，避免类型转换开销。

### 混合检索与融合

`src/memory/retrieve.ts`：

```typescript
const RRF_K = 60;

export type Hit = {
  id: number;
  source: string;
  heading: string;
  content: string;
  score: number;
  matchedBy: Array<"keyword" | "vector">;
};

export async function hybridSearch(
  db: ReturnType<typeof openIndex>,
  query: string,
  options: { topK?: number; scope?: string; candidates?: number } = {},
): Promise<Hit[]> {
  const candidates = options.candidates ?? 30;

  const keywordRows = db
    .prepare(
      `SELECT c.id, c.source, c.heading, c.content, bm25(chunks_fts) AS rank
       FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
       WHERE chunks_fts MATCH ? ${options.scope ? "AND c.source LIKE ?" : ""}
       ORDER BY rank LIMIT ?`,
    )
    .all(...(options.scope ? [query, `${options.scope}%`, candidates] : [query, candidates])) as Array<{
    id: number;
    source: string;
    heading: string;
    content: string;
  }>;

  const [queryVector] = await embedAll([query]);
  const vectorRows = db
    .prepare(
      `SELECT c.id, c.source, c.heading, c.content, v.distance
       FROM chunks_vec v JOIN chunks c ON c.id = v.chunk_id
       WHERE v.embedding MATCH ? AND k = ?
       ORDER BY v.distance`,
    )
    .all(new Float32Array(queryVector), candidates) as Array<{
    id: number;
    source: string;
    heading: string;
    content: string;
  }>;

  return fuse(keywordRows, vectorRows).slice(0, options.topK ?? 8);
}

/** 倒数排名融合：只看名次，不看两路的分数尺度。 */
function fuse(
  keywordRows: Array<{ id: number } & Omit<Hit, "score" | "matchedBy">>,
  vectorRows: Array<{ id: number } & Omit<Hit, "score" | "matchedBy">>,
): Hit[] {
  const table = new Map<number, Hit & { keywordRank?: number; vectorRank?: number }>();

  keywordRows.forEach((row, index) => {
    table.set(row.id, { ...row, score: 0, matchedBy: ["keyword"], keywordRank: index + 1 });
  });
  vectorRows.forEach((row, index) => {
    const existing = table.get(row.id);
    if (existing) {
      existing.vectorRank = index + 1;
      existing.matchedBy.push("vector");
      return;
    }
    table.set(row.id, { ...row, score: 0, matchedBy: ["vector"], vectorRank: index + 1 });
  });

  return [...table.values()]
    .map((item) => ({
      ...item,
      score:
        (item.keywordRank ? 1 / (RRF_K + item.keywordRank) : 0) +
        (item.vectorRank ? 1 / (RRF_K + item.vectorRank) : 0),
    }))
    .sort((a, b) => b.score - a.score);
}
```

融合只使用名次，原因是关键词的 BM25 分数与向量的距离无法直接比较。倒数排名融合的好处是不需要调权重，两路召回都能保留。

### 结果组装

```typescript
export function renderHits(hits: Hit[]): string {
  if (hits.length === 0) return "没有找到相关内容。";
  return hits
    .map((hit, index) =>
      [
        `${index + 1}. ${hit.source}${hit.heading ? ` · ${hit.heading}` : ""}（相关度 ${hit.score.toFixed(4)}，命中方式：${hit.matchedBy.join("+")}）`,
        hit.content.slice(0, 800),
      ].join("\n"),
    )
    .join("\n\n");
}
```

返回给模型的内容带来源、相关度、命中方式三项。相关度让模型知道主次，命中方式让调试时能判断是哪一路召回起了作用。

## pi 的做法

**检索交给外部工具。** pi 的记忆检索调用 `qmd` 这个独立程序，通过命令行参数取回结果。qmd 的能力与讲义里的实现对应：

| 命令 | 能力 |
|------|------|
| `qmd search <query>` | 基于 BM25 的关键词检索，不调用模型 |
| `qmd vsearch <query>` | 只做向量相似度检索 |
| `qmd query <query>` | 混合检索，带查询扩展与重排 |
| `qmd embed` | 生成或刷新向量 |
| `qmd collection add/list/show` | 管理被索引的目录 |
| `qmd context add` | 为集合附加人工写的摘要 |
| `qmd cleanup` | 清理失活文档与孤立数据，压缩索引 |

`qmd query` 支持一种结构化查询形式，每一行带前缀标明这一行是关键词、向量还是假设性答案：

```
qmd query 'lex:..\nvec:...'
```

这一处设计与讲义里的两路召回思路一致，区别在于把融合与重排都放在了检索程序内部。

**程序侧的调用管理。** `pi-memory/index.ts` 负责启动外部程序、传环境变量、处理超时，并对可用性做缓存：

```typescript
const QMD_STATUS_CACHE_TTL_MS = 5 * 60 * 1000;
const QMD_STATUS_NEGATIVE_CACHE_TTL_MS = 5 * 1000;
```

正向结果缓存五分钟，负向结果只缓存五秒。刚安装检索工具的使用者不需要等待整个存活周期才能重试，这个区分很有实用价值。

**外部程序调用的两处细节。** 一是 `NO_COLOR=1` 并把 `FORCE_COLOR` 删掉，避免输出里混入颜色控制字符。二是对平台差异做处理：Windows 下的命令行封装脚本可能写入错误的解释器路径，因此改为直接用 `node` 调用程序的 JavaScript 入口。讲义里如果也走外部程序，这两处都需要处理。

**检索工具的另一条路径。** qmd 自带一个通过标准输入输出的服务模式（`qmd mcp`），可以把检索能力以协议形式暴露，宿主程序按第 8 讲的方式接入。这也是一种可行方案，适合检索能力需要跨产品复用的场景。

**索引与原文的关系。** 索引是派生数据，原文是权威来源。检索命中之后需要细节时回到原文。这一条与讲义里的结构一致：`chunks` 表保存原文，索引可以随时重建。

## 验收

1. 索引一个包含五十个 Markdown 文件的目录，检索一个只出现在其中一处的专有名词，该片段应当排在第一条，命中方式应当包含关键词。
2. 换一种说法提问同一件事，前三条结果里应当出现正确片段，命中方式应当包含向量。
3. 检索结果里每条都带来源与章节标题，点击来源能定位到原文件。
4. 把向量表清空只保留关键词索引，纯语义的提问应当返回较差结果，用来确认两路都在起作用。

## 常见错误

第一个错误是分块时不留重叠。跨块的句子在两边都读不到完整含义。

第二个错误是片段不带来源与章节。模型无法引用，使用者无法核实。

第三个错误是只使用向量检索。包含具体编号、函数名、错误码的查询会失效。

第四个错误是把两路分数直接相加。BM25 分数与向量距离的尺度不同，融合需要按名次。

第五个错误是索引更新时不删旧片段。同一个文件改动之后旧内容仍然能被检索到。