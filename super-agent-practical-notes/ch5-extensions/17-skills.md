# 17 · Skills：给 Agent 注入领域知识

> 章节：第五章 Skills + Plugins + Channel

## 本讲目标

把执行流程与领域约定从系统提示词里移出来，改成按需加载的文件单元。这一讲结束时，程序启动时只注入技能的名称、说明与位置，需要时才读取正文。

## 要写的代码

```
src/
├── skills.ts              发现、校验与注入
└── tools/
    └── skill-tool.ts      强制加载入口
```

### 发现

```typescript
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const SKIP_DIRS = new Set(["node_modules"]);

export type Skill = {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
};

export function discoverSkills(rootDirs: string[]): { skills: Skill[]; warnings: string[] } {
  const skills = new Map<string, Skill>();
  const warnings: string[] = [];

  for (const root of rootDirs) {
    if (!existsSync(root)) continue;
    for (const found of walk(root)) {
      const parsed = loadSkillFile(found);
      warnings.push(...parsed.warnings);
      if (!parsed.skill) continue;
      const existing = skills.get(parsed.skill.name);
      if (existing) {
        warnings.push(`技能名称冲突：${parsed.skill.name}（保留 ${existing.filePath}）`);
        continue;
      }
      skills.set(parsed.skill.name, parsed.skill);
    }
  }

  return { skills: [...skills.values()], warnings };
}

function* walk(dir: string): Generator<string> {
  const entries = readdirSync(dir, { withFileTypes: true });

  // 目录里有 SKILL.md 就把它当作技能根目录，不再向下递归
  if (entries.some((entry) => entry.name === "SKILL.md")) {
    yield join(dir, "SKILL.md");
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
      continue;
    }
    if (entry.name.endsWith(".md")) yield full;
  }
}

function loadSkillFile(filePath: string): { skill?: Skill; warnings: string[] } {
  const warnings: string[] = [];
  const raw = readFileSync(filePath, "utf-8");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!match) return { warnings: [`${filePath} 缺少 frontmatter`] };

  const frontmatter = parseFrontmatter(match[1]);
  const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  if (!description) return { warnings: [`${filePath} 缺少 description，未被加载`] };

  const directory = filePath.split(sep).slice(0, -1).join(sep);
  const name = typeof frontmatter.name === "string" ? frontmatter.name : directory.split(sep).pop() ?? "";

  for (const message of validateName(name)) warnings.push(`${filePath}：${message}`);
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    warnings.push(`${filePath}：description 超过 ${MAX_DESCRIPTION_LENGTH} 字符`);
  }

  return {
    skill: {
      name,
      description,
      filePath,
      baseDir: directory,
      disableModelInvocation: frontmatter["disable-model-invocation"] === true,
    },
    warnings,
  };
}

export function validateName(name: string): string[] {
  const errors: string[] = [];
  if (name.length > MAX_NAME_LENGTH) errors.push(`name 超过 ${MAX_NAME_LENGTH} 字符`);
  if (!/^[a-z0-9-]+$/.test(name)) errors.push("name 只能包含小写字母、数字与连字符");
  if (name.startsWith("-") || name.endsWith("-")) errors.push("name 不能以连字符开头或结尾");
  if (name.includes("--")) errors.push("name 不能包含连续连字符");
  return errors;
}

function parseFrontmatter(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of text.split("\n")) {
    const match = /^([a-z-]+):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, key, value] = match;
    if (value === "true") result[key] = true;
    else if (value === "false") result[key] = false;
    else result[key] = value.replace(/^["']|["']$/g, "");
  }
  return result;
}
```

名称与说明存在问题只产生警告，说明缺失时该技能不被加载。名称冲突时保留先发现的，并给出冲突诊断。这几条策略决定了技能目录可以逐步整理，不需要一次写对。

### 注入

```typescript
export function renderSkillsForPrompt(skills: Skill[]): string {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return "";

  const items = visible.map((skill) =>
    [
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${escapeXml(skill.filePath)}</location>`,
      "  </skill>",
    ].join("\n"),
  );

  return [
    "以下技能提供特定任务的专用说明。任务与说明匹配时，用读取工具打开技能文件。",
    "技能文件里出现的相对路径相对于该技能目录解析（SKILL.md 所在目录），在工具调用里使用绝对路径。",
    "遇到技能文件里引用的脚本，按它所处的目录执行。",
    "",
    "<available_skills>",
    ...items,
    "</available_skills>",
  ].join("\n");
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
```

说明文字里必须包含位置与路径解析规则。只给位置的时候，技能文件里的相对路径会按工作目录解析，引用的脚本找不到。

### 强制加载入口

```typescript
export function registerSkillTool(deps: { loadSkill: (name: string) => string }): void {
  registerTool({
    name: "load_skill",
    description: "加载指定技能的完整说明。当你确定某个技能适用于当前任务，或者使用者明确要求时使用。",
    snippet: "加载技能的完整说明",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "技能名称" },
        args: { type: "string", description: "附加的请求，会作为使用者消息追加在技能说明之后" },
      },
      required: ["name"],
    },
    async execute({ name, args }) {
      try {
        const instructions = deps.loadSkill(name);
        return {
          content: args ? `${instructions}\n\n使用者请求：${args}` : instructions,
          details: { skill: name },
        };
      } catch (error) {
        return {
          content: `加载技能 ${name} 失败：${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  });
}
```

这个工具同时承担两个作用：给模型一个主动加载的入口，给使用者一个强制加载的入口。按需加载的漏加载问题是已知的，强制入口用来兜底。

### 说明文字的写法

```markdown
---
name: mini-build
description: 微信小程序构建与体验版二维码。当使用者要求打包小程序、触发构建、上传体验版、获取体验二维码、查询小程序清单时使用。不负责分支搜索与代码修改。
---
```

说明写清三件事：做什么、什么时候用、不负责什么。第三件在技能数量增长之后价值很高，它能减少相邻技能之间的误触发。

## pi 的做法

**扫描规则。** `dist/core/skills.js` 的规则与讲义一致：目录里有 `SKILL.md` 就当作技能根目录且不再向下递归；否则读取根目录下直接的 Markdown 文件，并继续向子目录递归。`.gitignore`、`.ignore`、`.fdignore` 三类忽略文件生效，`node_modules` 与点号开头的目录跳过。符号链接会解析到真实路径用于去重。

**校验规则。** 名称上限 64 字符，只允许小写字母、数字与连字符，不允许首尾连字符与连续连字符；说明上限 1024 字符。名称与说明有问题产生警告但不阻止加载，说明缺失时该技能不被加载，名称冲突保留先发现的并产生冲突诊断。pi 不要求名称与目录名一致，但文档指出其他实现可能要求，因此保持一致更便于移植。

**清单格式。** `formatSkillsForPrompt` 生成的清单带名称、说明、位置三个字段，并在前面加两句读取说明：

```
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory
(parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.
```

第二句是必要补充，讲义里的 `renderSkillsForPrompt` 也带上了它。

**排除自动触发。** `disable-model-invocation: true` 的技能从清单里排除，只能通过显式命令调用。这一处给「不希望模型自行触发」的技能留了位置。

**段落补丁。** 技能清单只出现在系统提示词的 `skills` 一段。新技能出现导致清单变化时，只有这一段被写入会话记录，其余段落保持原样，提示词缓存不受影响。

**信任门禁。** 项目级技能属于需要项目信任的资源，`trust-manager.js` 的资源清单里包含 `.pi/skills` 与项目 `.agents/skills`；未授予信任时这些目录不会被加载。使用者级目录始终视为已信任。这一处对应第 20 讲的权限话题。

**漏加载的兜底。** 文档里明确写出模型可能漏加载相关技能，并给出 `强制加载命令` 作为补充入口。承认机制存在漏加载，并提供一个显式入口，比假设模型总能判断正确更可靠。

## 验收

1. 放一个技能目录，启动时打印的技能数量加一，注入的字符数只增加说明与位置的长度，不包含正文。
2. 提问一个与技能说明匹配的任务，模型应当先读取技能文件，再按文件里的步骤执行。
3. 用强制加载入口加载一个技能，正文应当进入对话历史，并且后续步骤按正文执行。
4. 把说明留空，该技能应当不被加载并给出提示；把名称写成大写，应当给出命名警告但技能仍然可用。

## 常见错误

第一个错误是把技能正文写进系统提示词。全部技能常驻会让提示词迅速膨胀，按需加载的收益全部丢失。

第二个错误是说明只写功能。触发率低，技能存在但用不上。

第三个错误是不给路径解析规则。技能里引用的脚本按工作目录解析，找不到文件。

第四个错误是技能数量增长之后不整理。清单的累计开销与判断干扰都是实际成本。

第五个错误是没有强制加载入口。漏加载时无法补救。