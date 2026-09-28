# 10 · Session 持久化与模块化提示词组装

> 章节：第三章 Context Engineering

## 本讲目标

把对话写进文件，进程重启之后能接着之前的状态继续；把系统提示词从一段字符串改造成可以按部分替换的段落对象。这一讲结束时，会话以追加方式写入文件，提示词的变化只记录变化的那一部分。

## 要写的代码

```
src/context/
├── session.ts        会话存储与分支
├── prompt-pipe.ts    提示词组装与增量更新
└── entries.ts        条目类型
```

### 条目与文件格式

`src/context/entries.ts`：

```typescript
export type EntryBase = {
  id: string;
  parentId: string | null;
  timestamp: string;
};

export type SessionHeader = {
  type: "session";
  version: 3;
  id: string;
  timestamp: string;
  cwd: string;
};

export type MessageEntry = EntryBase & {
  type: "message";
  message: {
    role: "system" | "user" | "assistant" | "toolResult";
    text: string;
    sections?: Record<string, string | null>;
    toolsAdded?: string[];
    toolsRemoved?: string[];
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  };
};

export type CompactionEntry = EntryBase & {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
};

export type SessionEntry = MessageEntry | CompactionEntry;
```

文件是一行一个 JSON 对象的文本文件：

```json
{"type":"session","version":3,"id":"3f1a...","timestamp":"2026-09-24T02:10:00.000Z","cwd":"/path/to/project"}
{"type":"message","id":"a0b1c2d3","parentId":null,"timestamp":"...","message":{"role":"user","text":"读一下 package.json"}}
{"type":"message","id":"d4e5f6a7","parentId":"a0b1c2d3","timestamp":"...","message":{"role":"assistant","text":"","toolCalls":[...]}}
```

### 会话存储

`src/context/session.ts`：

```typescript
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionEntry, SessionHeader, MessageEntry } from "./entries.ts";

export class SessionStore {
  private entries: SessionEntry[] = [];
  private currentId: string | null = null;

  private constructor(private readonly filePath: string, private readonly header: SessionHeader) {}

  static async open(input: { dir: string; cwd: string; sessionId?: string }): Promise<SessionStore> {
    const sessionId = input.sessionId ?? randomUUID();
    const slug = input.cwd.replace(/^\//, "").replace(/[/:\\]/g, "-");
    const filePath = join(input.dir, `--${slug}--`, sessionId, "session.jsonl");
    const header: SessionHeader = {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd: input.cwd,
    };
    const store = new SessionStore(filePath, header);
    await store.load();
    return store;
  }

  private async load(): Promise<void> {
    let raw = "";
    try {
      raw = await readFile(this.filePath, "utf-8");
    } catch {
      await mkdir(dirname(this.filePath), { recursive: true });
      await this.atomicWrite(`${JSON.stringify(this.header)}\n`);
      return;
    }
    const lines = raw.split("\n").filter(Boolean);
    for (const line of lines) {
      const entry = JSON.parse(line) as SessionHeader | SessionEntry;
      if (entry.type === "session") continue;
      this.entries.push(entry);
      this.currentId = entry.id;
    }
  }

  get currentEntryId(): string | null {
    return this.currentId;
  }

  /** 从根到当前节点的路径，就是下一次请求要用的消息序列。 */
  activeBranch(): SessionEntry[] {
    const byId = new Map(this.entries.map((entry) => [entry.id, entry]));
    const path: SessionEntry[] = [];
    let cursor = this.currentId;
    while (cursor) {
      const entry = byId.get(cursor);
      if (!entry) break;
      path.unshift(entry);
      cursor = entry.parentId;
    }
    return path;
  }

  async append(input: Omit<MessageEntry, "type" | "id" | "parentId" | "timestamp">["message"] extends never ? never : {
    message: MessageEntry["message"];
  }): Promise<MessageEntry> {
    const entry: MessageEntry = {
      type: "message",
      id: randomUUID().slice(0, 8),
      parentId: this.currentId,
      timestamp: new Date().toISOString(),
      message: input.message,
    };
    await this.writeEntry(entry);
    return entry;
  }

  /** 从历史节点继续，形成新分支。 */
  async branchFrom(entryId: string, message: MessageEntry["message"]): Promise<MessageEntry> {
    this.currentId = entryId;
    return this.append({ message });
  }

  async appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number) {
    const entry = {
      type: "compaction" as const,
      id: randomUUID().slice(0, 8),
      parentId: this.currentId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
    };
    await this.writeEntry(entry);
    return entry;
  }

  private async writeEntry(entry: SessionEntry): Promise<void> {
    this.entries.push(entry);
    this.currentId = entry.id;
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf-8");
  }

  private async atomicWrite(content: string): Promise<void> {
    const temp = `${this.filePath}.tmp`;
    await writeFile(temp, content, "utf-8");
    await rename(temp, this.filePath);
  }
}
```

三处设计要点：写入用追加方式，中途中断最多丢掉最后一行；当前节点决定活动分支，从历史节点继续会形成新分支；条目之间通过 `parentId` 连接，因此同一文件里可以容纳多条历史路径。

### 提示词段落

`src/context/prompt-pipe.ts`：

```typescript
export type PromptSections = Record<string, string>;

const SECTION_NAME = /^[a-z][a-z0-9_-]*$/;

export function buildSections(input: {
  identity: string;
  tools: Array<{ name: string; snippet?: string }>;
  guidelines: string[];
  contextFiles: Array<{ path: string; content: string }>;
  skills: Array<{ name: string; description: string; location: string }>;
  cwd: string;
  addendum?: string;
}): Record<string, string> {
  const sections: Record<string, string> = {};

  sections.preamble = input.identity;
  sections.tools = permissiveToolList(input.tools);
  sections.rules = input.guidelines.map((rule) => `- ${rule}`).join("\n");

  if (input.contextFiles.length > 0) {
    sections.project_context = input.contextFiles
      .map((file) => `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`)
      .join("\n\n");
  }
  if (input.skills.length > 0) {
    sections.skills = renderSkills(input.skills);
  }
  if (input.addendum) {
    sections.addendum = input.addendum;
  }
  sections.cwd = input.cwd;

  for (const name of Object.keys(sections)) {
    if (name !== "preamble" && !SECTION_NAME.test(name)) {
      throw new Error(`段落名称不合法：${name}`);
    }
  }
  return sections;
}

function permissiveToolList(tools: Array<{ name: string; snippet?: string }>): string {
  const lines = tools
    .filter((tool) => tool.snippet)
    .map((tool) => `- ${tool.name}: ${tool.snippet}`);
  return `${lines.join("\n")}\n\n除上述工具外，项目还可能提供其他自定义工具。`;
}

function renderSkills(skills: Array<{ name: string; description: string; location: string }>): string {
  const items = skills.map((skill) =>
    [
      "  <skill>",
      `    <name>${skill.name}</name>`,
      `    <description>${skill.description}</description>`,
      `    <location>${skill.location}</location>`,
      "  </skill>",
    ].join("\n"),
  );
  return [
    "需要时用读取工具打开技能文件。技能文件里的相对路径相对于该技能目录解析。",
    "<available_skills>",
    ...items,
    "</available_skills>",
  ].join("\n");
}

export function renderPrompt(sections: Record<string, string>): string {
  const parts = [sections.preamble];
  for (const [name, content] of Object.entries(sections)) {
    if (name === "preamble" || !content) continue;
    parts.push(`<${name}>\n${content}\n</${name}>`);
  }
  return parts.join("\n\n");
}

/** 只返回变化的段落；值为 null 表示删除该段落。 */
export function diffSections(
  previous: Record<string, string>,
  current: Record<string, string>,
): Record<string, string | null> | undefined {
  const patch: Record<string, string | null> = {};
  for (const [name, text] of Object.entries(current)) {
    if (previous[name] !== text) patch[name] = text;
  }
  for (const name of Object.keys(previous)) {
    if (current[name] === undefined) patch[name] = null;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}
```

段落对象有两个直接收益。第一，段落可以按名称单独替换，技能清单变化时只更新 `skills` 一段。第二，模型看到的是有边界的区块，遵循程度高于一整段连续文字。

### 首轮写入与后续补丁

```typescript
let lastSections: Record<string, string> = {};

async function syncPrompt(sections: Record<string, string>): Promise<void> {
  if (Object.keys(lastSections).length === 0) {
    await session.append({
      message: { role: "system", text: "", sections },
    });
    lastSections = sections;
    return;
  }
  const patch = diffSections(lastSections, sections);
  if (!patch) return;
  await session.append({
    message: { role: "system", text: "", sections: patch },
  });
  lastSections = sections;
}
```

首轮写入完整段落，之后只写补丁。回放时按顺序合并即可得到当前提示词。

## pi 的做法

**会话文件的位置与格式。** pi 的会话写在 `~/.pi/agent/sessions/--<路径>--/<时间戳>_<会话标识>.jsonl`，路径部分由工作目录转换而来。`docs/session-format.md` 列出了完整的条目类型：会话头、消息、模型切换、思考等级切换、用量、压缩、分支摘要、上下文编辑。条目之间的关系是 `id` 与 `parentId` 构成的树，当前条目决定活动分支。

**系统消息承载提示词与工具集合。** 这是 pi 会话格式里最有参考价值的一处设计：

```
System messages carry the prompt and tool loadout: the first request of a session persists
one with every prompt section and tool declaration, and later changes persist as system
messages that patch sections by name (null removes one) and list toolsAdded/toolsRemoved.
Replaying them in order yields the current prompt and tools; there is no separate prompt
state entry.
```

讲义里的 `syncPrompt` 与 `declareToolChanges` 对应这一处。

**段落生成的细节。** `dist/core/system-prompt.js` 的默认实现包含四个额外处理：`tools` 段落末尾固定附加一句「除上述工具外，项目还可能提供其他自定义工具」；`rules` 段落按当前选中的工具逐个追加该工具的 `promptGuidelines`，并用集合去重；上下文文件渲染进独立的 `project_context` 段落，每个文件包一层带路径的标签；段落名不允许占用 `preamble`，不合规时直接抛出错误。

**投影。** `dist/core/session-manager.js` 的 `buildSessionProjection` 负责把活动分支上的条目投影成消息序列，压缩条目、分支摘要条目、上下文编辑条目在这一步被展开或省略。讲义里的 `activeBranch` 是这一步的最小版本。

**原子写入。** pi 写入时使用临时文件加改名的方式，避免写入中断造成文件损坏。讲义里的 `atomicWrite` 只用于初始化头部，日常写入走追加。

## 验收

1. 完成一次多轮对话，退出进程，用同一个会话标识重新启动，应当能接着之前的内容继续提问。
2. 打开会话文件，每一行都是一个完整 JSON 对象；最后一行被手动截断之后，程序仍然能从前面几行恢复。
3. 让技能清单发生变化，会话文件里应当新增一条只包含 `skills` 段落的系统消息。
4. 从历史中的某一条消息继续提问，会话文件里的新条目应当引用那一条消息的标识。

## 常见错误

第一个错误是整段重写会话文件。追加写入更安全，中途中断只影响最后一行。

第二个错误是每次请求都写入完整提示词。段落补丁的意义就是让变化量最小。

第三个错误是把当前节点只放在内存里。重启之后活动分支丢失，会话恢复变成从头开始。

第四个错误是把分支做成新文件。同一文件里的树结构让历史路径可以共存，排查问题时可以看到全部过程。

第五个错误是段落名称不加校验。名称不合规时渲染出来的标签会破坏结构，且难以定位。