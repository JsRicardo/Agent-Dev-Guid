# 16 · 给记忆库做体检

> 章节：第四章 Memory + RAG

## 本讲目标

记忆系统用久了会出问题：写入噪音、内容过时、条目冲突、范围错配、数量膨胀。这一讲结束时，程序提供删除可恢复、冲突可检测、状态可流转、健康可查看四项能力。

## 要写的代码

```
src/memory/
├── maintain.ts    检查与整理
└── recovery.ts    删除恢复
```

### 删除可恢复

```typescript
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type RecoveryRecord = {
  recoveryId: string;
  target: MemoryTarget;
  date?: string;
  removedBlocks: string[];
  removedAt: string;
};

export async function forgetBlocks(input: {
  target: MemoryTarget;
  match: string;
  date?: string;
}): Promise<{ recoveryId: string; removed: number }> {
  const filePath = fileFor(input.target, input.date);
  const content = await readFile(filePath, "utf-8");
  const blocks = content.split(/\n(?=##\s)/);
  const needle = input.match.toLowerCase();
  const kept: string[] = [];
  const removed: string[] = [];

  for (const block of blocks) {
    if (block.toLowerCase().includes(needle)) removed.push(block);
    else kept.push(block);
  }

  if (removed.length === 0) {
    throw new Error(`没有找到包含「${input.match}」的条目`);
  }

  const recoveryId = randomUUID();
  const dir = join(memoryDir(), "recovery");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${recoveryId}.json`),
    JSON.stringify(
      {
        recoveryId,
        target: input.target,
        date: input.date,
        removedBlocks: removed,
        removedAt: new Date().toISOString(),
      } satisfies RecoveryRecord,
      null,
      2,
    ),
    "utf-8",
  );

  await writeFile(filePath, kept.join("\n"), "utf-8");
  return { recoveryId, removed: removed.length };
}

export async function restoreBlocks(recoveryId: string): Promise<number> {
  const dir = join(memoryDir(), "recovery");
  const filePath = join(dir, `${recoveryId}.json`);
  const record = JSON.parse(await readFile(filePath, "utf-8")) as RecoveryRecord;
  const target = fileFor(record.target, record.date);
  const current = await readFile(target, "utf-8").catch(() => "");
  const missing = record.removedBlocks.filter((block) => !current.includes(block));
  if (missing.length === 0) return 0;
  await writeFile(target, `${current}\n${missing.join("\n")}`, "utf-8");
  await unlink(filePath);
  return missing.length;
}

function fileFor(target: MemoryTarget, date?: string): string {
  if (target === "long_term") return join(memoryDir(), "MEMORY.md");
  if (target === "scratchpad") return join(memoryDir(), "SCRATCHPAD.md");
  return join(memoryDir(), "daily", `${date ?? new Date().toISOString().slice(0, 10)}.md`);
}
```

删除做成可恢复的动作有一个直接理由：整理记忆时删多了无法挽回，恢复记录把这件事变成可以撤销的操作。删除时按块处理，避免只删掉半条记录。

### 冲突检测

```typescript
export type ConflictKind = "same_file" | "cross_file" | "implicit";

export type Conflict = {
  kind: ConflictKind;
  incoming: string;
  existing: { title: string; body: string; file: string };
  reason: string;
};

export async function detectConflicts(incoming: { title: string; body: string }): Promise<Conflict[]> {
  const conflicts: Conflict[] = [];
  const entries = await loadAllEntries();

  const keywords = extractKeywords(`${incoming.title} ${incoming.body}`);

  for (const entry of entries) {
    const overlap = keywords.filter((word) => `${entry.title} ${entry.body}`.includes(word));
    if (overlap.length === 0) continue;

    if (negates(incoming.body, entry.body)) {
      conflicts.push({
        kind: entry.file === "MEMORY.md" ? "same_file" : "cross_file",
        incoming: incoming.title,
        existing: entry,
        reason: `两者在 ${overlap.slice(0, 3).join("、")} 上的结论不一致`,
      });
      continue;
    }

    if (entry.meta.refs >= 3 && !consistent(incoming.body, entry.body)) {
      conflicts.push({
        kind: "implicit",
        incoming: incoming.title,
        existing: entry,
        reason: `已有条目被引用 ${entry.meta.refs} 次，新内容的表述与其不一致`,
      });
    }
  }

  return conflicts;
}

function negates(left: string, right: string): boolean {
  const negative = [/不要|禁止|避免|不再|废弃|已过期/];
  const leftHas = negative.some((pattern) => pattern.test(left));
  const rightHas = negative.some((pattern) => pattern.test(right));
  return leftHas !== rightHas;
}

function consistent(left: string, right: string): boolean {
  const leftValues = left.match(/[\w./-]{4,}/g) ?? [];
  const rightValues = new Set(right.match(/[\w./-]{4,}/g) ?? []);
  return leftValues.every((value) => rightValues.has(value));
}

function extractKeywords(text: string): string[] {
  return [...new Set(text.split(/[\s，。、；：()（）]+/).filter((word) => word.length >= 2))];
}
```

三类冲突的检测成本不同：同文件冲突最好发现，跨文件冲突需要遍历全部条目，隐含冲突最难，判据只能做成「与被引用多次的结论不一致时提示人工确认」。检测结果不自动处理，交给使用者决定是覆盖还是并存。

### 状态流转

```typescript
const ORDER: Maturity[] = ["draft", "validated", "standardized", "deprecated", "archived"];

export const TRANSITIONS: Record<Maturity, Maturity[]> = {
  draft: ["validated", "deprecated"],
  validated: ["standardized", "deprecated"],
  standardized: ["deprecated"],
  deprecated: ["archived", "validated"],
  archived: [],
};

export function promote(entry: MemoryEntry, next: Maturity): MemoryEntry {
  if (!TRANSITIONS[entry.meta.maturity].includes(next)) {
    throw new Error(`不允许从 ${entry.meta.maturity} 变成 ${next}`);
  }
  return { ...entry, meta: { ...entry.meta, maturity: next } };
}
```

状态流转需要限制方向。已归档的条目不允许直接回到可检索状态，需要先回到已废弃再重新验证。这条限制防止误操作把一批旧内容重新激活。

### 健康检查

```typescript
export async function healthReport(): Promise<string> {
  const entries = await loadAllEntries();
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  const byMaturity = new Map<Maturity, number>();
  const byScope = new Map<string, number>();
  const stale: string[] = [];
  const noisy: string[] = [];

  for (const entry of entries) {
    byMaturity.set(entry.meta.maturity, (byMaturity.get(entry.meta.maturity) ?? 0) + 1);
    byScope.set(entry.meta.scope, (byScope.get(entry.meta.scope) ?? 0) + 1);

    const ageDays = (now - Date.parse(entry.meta.lastRelevant)) / DAY;
    if (entry.meta.maturity === "standardized" && ageDays > 180) stale.push(entry.title);
    if (entry.meta.refs === 0 && ageDays > 60) noisy.push(entry.title);
  }

  const lines = [
    `条目总数：${entries.length}`,
    `状态分布：${[...byMaturity].map(([key, value]) => `${key} ${value}`).join("，")}`,
    `作用范围分布：${[...byScope].map(([key, value]) => `${key} ${value}`).join("，")}`,
    `超过 180 天未更新的标准化条目：${stale.length} 条`,
    `超过 60 天未被引用的条目：${noisy.length} 条`,
  ];
  if (stale.length > 0) lines.push(`待核对：${stale.slice(0, 5).join("、")}`);
  if (noisy.length > 0) lines.push(`待整理：${noisy.slice(0, 5).join("、")}`);
  return lines.join("\n");
}
```

报告给出的是待处理清单，处理动作仍然由使用者或模型在明确指令下执行。自动清理的边界很难确定：低频但重要的结论很容易被误判为无用。

## pi 的做法

**删除与恢复。** `pi-memory/index.ts` 里的 `forgetBlocks` 与 `writeRecoveryRecord`、`readRecoveryRecord` 实现同一套机制：删除时把被移除的内容写成一条恢复记录，返回一个可见的恢复标识，发现删错时可以按标识还原。记录文件放在 `recovery/` 目录下。

**冲突检测写在规则里。** pi 的记忆写入规则要求新条目写入之前检查三个层次：同文件冲突、跨文件冲突、隐含冲突。第三类需要按主题关键词做一次检索再判断，因此检测成本与写入频率成正比，写入频率需要控制。

**删除与覆盖的取舍。** 处理一个已经不成立的结论时，pi 的工具语义是「按匹配内容删除」并生成恢复记录，新结论作为新条目重新写入。同一时刻文件里的内容是自洽的，历史状态保存在恢复记录里。这样不存在「两条矛盾记录谁被检索到」的问题。

**检索默认走精确匹配。** `memory_search` 的默认模式是关键词，语义模式在精确匹配找不到时才使用。语义模式容易把「表达接近」的内容召回进来，因此不作为默认路径。

**状态与元数据参与过滤。** 成熟度为已废弃或已归档的条目不参与检索，作用范围不匹配的条目也不参与。这两条过滤在检索之前执行，不给排序留下出错空间。

**退出摘要。** `pi-memory` 在会话结束时生成一份退出摘要（`generateExitSummary`），把本次会话的结论整理进当日记录。这一步把「会话过程」与「长期结论」分开处理：过程进当日记录，只有明确是结论的内容才进入长期条目。

## 验收

1. 删除一条记忆，删除返回一个恢复标识；按该标识恢复，内容应当回到原文件。
2. 写入一条与已有条目结论相反的记忆，检测函数应当报出冲突，并给出冲突类型与原因。
3. 把一条记忆从草稿改为已验证，再从已验证改为已归档；尝试从已归档直接改回已验证，应当被拒绝。
4. 运行健康检查，输出的条目总数与实际文件里的条目数一致。

## 常见错误

第一个错误是删除没有恢复路径。整理过程中误删之后无法挽回。

第二个错误是按字符串包含删除。匹配范围过宽时一次删掉多条无关记录。

第三个错误是冲突检测只做同文件。跨文件与隐含冲突才是实际影响判断的类别。

第四个错误是状态可以任意回退。已归档的条目被误操作激活之后，旧内容重新参与检索。

第五个错误是自动清理。低频但重要的结论很容易被误判为无用，清理动作需要明确指令。