# 22 · 实现 Sub-Agent 机制

> 章节：第六章 权限 + Cron + Multi-Agent

## 本讲目标

把大任务分成几个各自独立的运行。这一讲结束时，子智能体有独立的上下文与工具白名单，写操作可以在独立工作目录里进行，结果按结构返回，并且父级预算会按份额划拨。

## 要写的代码

```
src/subagent/
├── types.ts
├── context.ts     上下文模式与剪枝
├── workspace.ts   工作目录隔离
├── budget.ts      预算划拨
├── accept.ts      验收与门禁
├── runner.ts      子运行
└── tool.ts        subagent 工具
```

### 上下文模式

```typescript
import type { Message } from "../types.ts";

export type ContextMode = "fresh" | "fork" | "profile";

/** fork 模式只带最近若干条消息，并把工具结果压缩成简短记录。 */
export function buildChildContext(input: {
  mode: ContextMode;
  parentMessages: Message[];
  task: string;
  keepRecent?: number;
}): Message[] {
  if (input.mode === "fresh") {
    return [{ role: "user", text: input.task }];
  }

  const keepRecent = input.keepRecent ?? 12;
  const recent = input.parentMessages.slice(-keepRecent);
  const pruned: Message[] = recent.map((message) => {
    if (message.role !== "toolResult") return message;
    return { ...message, text: `[已压缩] ${message.name} 的结果（${message.text.length} 字符）` };
  });

  return [
    { role: "system", text: "以下内容是主会话的最近记录，用于提供背景。任务说明在最后一条消息里。" },
    ...pruned,
    { role: "user", text: input.task },
  ];
}
```

`fresh` 只带任务说明，`fork` 带一段经过剪枝的主会话记录，`profile` 由子智能体定义声明默认模式。剪枝的意义在这里最明显：带一点背景与带全部工具结果，子会话的长度差别可能达到十倍。

### 工作目录隔离

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const run = promisify(execFile);

export async function createWorktree(input: {
  repo: string;
  taskId: string;
  baseRef: string;
}): Promise<{ path: string; branch: string }> {
  const status = await run("git", ["-C", input.repo, "status", "--porcelain"]);
  if (status.stdout.trim() !== "") {
    throw new Error("源工作目录存在未提交的改动，无法创建工作目录");
  }

  const branch = `agent/${input.taskId}`;
  const path = join(input.repo, "..", `.worktrees`, input.taskId);
  await run("git", ["-C", input.repo, "worktree", "add", "-b", branch, path, input.baseRef]);
  return { path, branch };
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  await run("git", ["-C", repo, "worktree", "remove", "--force", path]);
}
```

两条规则：源工作目录必须干净，否则分配失败；一个工作目录同一时间只允许一个写入者。第二条是并行写入不互相覆盖的根本保障。

### 预算划拨

```typescript
export type Budget = {
  tokens: { soft: number; hard: number };
  costUsd?: { soft: number; hard: number };
  toolCalls?: { soft: number; hard: number };
  timeoutMs: number;
};

export function splitBudget(parent: Budget, shares: number[]): Budget[] {
  const total = shares.reduce((sum, share) => sum + share, 0);
  return shares.map((share) => ({
    tokens: {
      soft: Math.floor((parent.tokens.soft * share) / total),
      hard: Math.floor((parent.tokens.hard * share) / total),
    },
    costUsd: parent.costUsd
      ? {
          soft: (parent.costUsd.soft * share) / total,
          hard: (parent.costUsd.hard * share) / total,
        }
      : undefined,
    toolCalls: parent.toolCalls
      ? {
          soft: Math.floor((parent.toolCalls.soft * share) / total),
          hard: Math.floor((parent.toolCalls.hard * share) / total),
        }
      : undefined,
    timeoutMs: parent.timeoutMs,
  }));
}

export function checkBudget(usage: { tokens: number; toolCalls: number; costUsd: number }, budget: Budget) {
  return {
    softExceeded: usage.tokens > budget.tokens.soft || (budget.toolCalls ? usage.toolCalls > budget.toolCalls.soft : false),
    hardExceeded: usage.tokens >= budget.tokens.hard || (budget.toolCalls ? usage.toolCalls >= budget.toolCalls.hard : false),
    deadlineAt: Date.now() + budget.timeoutMs,
  };
}
```

预算从父任务向子任务划拨。嵌套两层之后，独立上限会让总消耗远超预期。软上限触发提示，硬上限触发收尾：达到硬上限之后按白名单屏蔽读取类工具，迫使子智能体基于已有信息给出结论。

### 子运行

```typescript
export type SubTaskResult = {
  summary: string;
  artifacts: string[];
  evidence: string[];
  unresolved: string[];
  usage: { input: number; output: number; toolCalls: number };
};

export async function runChild(input: {
  agent: { name: string; systemPrompt: string; tools: string[]; maxSteps: number };
  task: string;
  cwd: string;
  context: ContextMode;
  parentMessages: Message[];
  budget: Budget;
  signal?: AbortSignal;
}): Promise<SubTaskResult> {
  const messages = buildChildContext({
    mode: input.context,
    parentMessages: input.parentMessages,
    task: input.task,
  });

  const tools = input.agent.tools
    .map((name) => getTool(name))
    .filter((tool): tool is Tool => Boolean(tool));

  const usage = { input: 0, output: 0, toolCalls: 0 };
  const evidence: string[] = [];
  const artifacts: string[] = [];

  for (let step = 0; step < input.agent.maxSteps; step++) {
    const response = await callModel(messages, tools, input.signal);
    usage.input += response.usage?.input ?? 0;
    usage.output += response.usage?.output ?? 0;
    messages.push(response);

    const state = checkBudget({ tokens: usage.input + usage.output, toolCalls: usage.toolCalls, costUsd: 0 }, input.budget);
    if (state.hardExceeded) {
      messages.push({ role: "user", text: "已达预算上限，请基于现有信息给出结论，说明哪些部分没有完成。" });
      const closing = await callModel(messages, [], input.signal);
      messages.push(closing);
      return finish(messages, usage, evidence, artifacts);
    }

    if (response.stopReason !== "toolCalls") break;

    for (const call of response.toolCalls) {
      usage.toolCalls++;
      const result = await executeOne(call, { cwd: input.cwd, signal: input.signal });
      messages.push({ role: "toolResult", callId: call.id, name: call.name, text: result.text, isError: result.isError });
      if (["write", "edit"].includes(call.name)) {
        artifacts.push(String((call.args as { path?: string }).path ?? ""));
      }
      if (call.name === "bash" && !result.isError) {
        evidence.push(result.text.slice(0, 400));
      }
    }
  }

  return finish(messages, usage, evidence, artifacts);
}

function finish(messages: Message[], usage: SubTaskResult["usage"], evidence: string[], artifacts: string[]): SubTaskResult {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  return {
    summary: lastAssistant?.text ?? "(子任务没有给出结论)",
    artifacts: [...new Set(artifacts)],
    evidence,
    unresolved: extractUnresolved(lastAssistant?.text ?? ""),
    usage,
  };
}

function extractUnresolved(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => /未完成|没有验证|待确认|无法确定/.test(line))
    .map((line) => line.trim());
}
```

`unresolved` 字段用来传递未解决的问题。缺少这个字段时，父级会认为任务已经完成。

### 验收与门禁

```typescript
export type Acceptance = {
  policy: "auto" | "attested" | "checked";
  gate?: { command: string; timeoutMs?: number };
};

export async function accept(result: SubTaskResult, policy: Acceptance, cwd: string): Promise<{ ok: boolean; reason: string }> {
  if (policy.policy === "auto") return { ok: true, reason: "不做检查" };

  if (policy.policy === "checked" && policy.gate) {
    try {
      const outcome = await run(policy.gate.command, { cwd, timeout: policy.gate.timeoutMs ?? 120_000, shell: true });
      return { ok: true, reason: `门禁命令通过：${policy.gate.command}`, ...outcome };
    } catch (error) {
      return { ok: false, reason: `门禁命令失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  if (result.artifacts.length === 0) {
    return { ok: false, reason: "子任务报告完成但没有产出文件" };
  }
  if (result.evidence.length === 0) {
    return { ok: false, reason: "子任务没有给出执行证据" };
  }
  return { ok: true, reason: `产出 ${result.artifacts.length} 个文件并给出 ${result.evidence.length} 条证据` };
}
```

三种策略：`auto` 不做检查，`attested` 检查产出与证据是否存在，`checked` 执行一条门禁命令并把退出码作为判定依据。最后一种最可靠，因为子智能体报告的完成与实际状态之间需要一条外部约束。

### 工具入口

```typescript
export function registerSubagentTool(deps: { runChild: typeof runChild; parentBudget: () => Budget; parentMessages: () => Message[] }) {
  registerTool({
    name: "subagent",
    description:
      "启动一个子智能体处理独立任务。子智能体有独立的上下文与工具白名单，写操作可以在独立工作目录里进行，结果按结构返回。",
    snippet: "启动子智能体处理独立任务",
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string", description: "子智能体名称" },
        task: { type: "string", description: "任务说明，需要自包含" },
        context: { type: "string", enum: ["fresh", "fork", "profile"], description: "上下文模式" },
        cwd: { type: "string", description: "工作目录" },
        worktree: { type: "boolean", description: "是否使用独立工作目录" },
        baseRef: { type: "string", description: "独立工作目录的起点" },
        acceptance: { type: "string", enum: ["auto", "attested", "checked"] },
        timeoutMs: { type: "number", description: "超时毫秒数" },
      },
      required: ["agent", "task"],
    },
    async execute(args, ctx) {
      const agent = loadAgent(args.agent);
      const workspace = args.worktree
        ? await createWorktree({ repo: ctx.cwd, taskId: randomUUID().slice(0, 8), baseRef: args.baseRef ?? "HEAD" })
        : { path: args.cwd ?? ctx.cwd, branch: "-" };

      const [budget] = splitBudget(deps.parentBudget(), [1]);
      const result = await deps.runChild({
        agent,
        task: args.task,
        cwd: workspace.path,
        context: args.context ?? "fresh",
        parentMessages: deps.parentMessages(),
        budget: { ...budget, timeoutMs: args.timeoutMs ?? budget.timeoutMs },
        signal: ctx.signal,
      });

      const verdict = await accept(result, { policy: args.acceptance ?? "attested" }, workspace.path);

      return {
        content: [
          `## 结论\n${result.summary}`,
          result.artifacts.length > 0 ? `## 改动文件\n${result.artifacts.join("\n")}` : "",
          result.unresolved.length > 0 ? `## 未解决\n${result.unresolved.map((item) => `- ${item}`).join("\n")}` : "",
          `## 验收\n${verdict.ok ? "通过" : "未通过"}：${verdict.reason}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
        isError: !verdict.ok,
        details: { agent: args.agent, worktree: workspace, usage: result.usage, acceptance: verdict },
      };
    },
  });
}
```

### 子智能体定义

```yaml
---
name: scout
description: 快速了解代码仓库结构
tools: read, grep, glob
context: fresh
maxSteps: 15
---
你负责在较大的代码仓库里找出与任务相关的文件、入口与数据流向，给出下一步该从哪个文件开始。
不要修改任何文件。
```

定义文件放在 `agents/` 目录下，按名称加载，工具白名单在定义里固定，运行中不变化。

## pi 的做法

**上下文模式。** `pi-subagents` 提供 `fresh`、`fork`、`profile` 三种取值：`fresh` 只带任务说明；`fork` 带父会话记录的剪枝副本，剪枝逻辑在 `src/shared/pruned-fork.ts`，会话内容与工作目录分别处理；`profile` 使用 agent 定义声明的默认模式。讲义里的 `buildChildContext` 对应这三种。

**写操作隔离。** `worktree: true` 让每个子任务在独立 git 工作树里执行，`baseRef` 指定起点；分配的前提是源工作区干净；清理动作只生成计划不实际删除；一个工作目录同一时间只允许一个写入者。

**预算机制。** 工具参数里有 `toolBudget`（软上限与硬上限，达到硬上限之后按白名单屏蔽读取类工具）、`usageBudget`（Token 与金额上限）、`timeoutMs`、`maxSubagentSpawnsPerRun`、`checkpointBeforeDeadlineMs`。父级预算通过 `spawn-budget` 与 `run-fanout-budget` 向子级划拨。

**验收与门禁。** `acceptance` 决定证据策略，`gate` 在子智能体结束之后执行一条命令，把通过标准输出的结构化结果作为判定依据。这一条与讲义里的 `checked` 策略对应。

**结果回传分层。** 子智能体的结果可以只作为文本返回，也可以写入指定路径：`output` 指定输出文件，`outputMode` 取 `file-only` 时结果不进主上下文只写文件，`outputSchema` 让返回值带结构。需要细节时父级读文件，需要结论时读返回值，两条路径分开之后主上下文的占用可控。

**独立审查角色。** 内置角色里 `reviewer` 检查实现与测试，`evidence-auditor` 对重要结论做独立证据审查，`oracle` 在行动前提供第二意见且不修改文件。三个角色的共同点是上下文独立：不共享产出方的推理过程，因此判断不受其结论影响。

**追问与续接。** `resume` 以同一会话继续追问或提出质疑，并且保存了原本的 agent、模型与工具约定，因此追问不需要重新交代背景。运行中用 `steer` 追加要求而不重启。

**基础设施故障的处理规则。** 文档明确规定：工作流、子进程启动、提示词运行时、扩展加载、子工具链的失败属于运行环境故障，应当停止并报告确切的失败与运行标识，在未知状态下改用其他执行方式会放大副作用。

## 验收

1. 让两个子智能体并行处理互不相关的任务，各自使用独立工作目录，两边都完成后主目录里没有出现冲突改动。
2. 把子智能体的工具白名单改成只读，让模型尝试修改文件，应当找不到写入工具。
3. 让一个子任务故意报告完成但不产生任何文件，`attested` 验收应当不通过并给出理由。
4. 让子任务执行一个必然失败的检查命令，`checked` 验收应当不通过，主流程据此决定是否返工。
5. 让子任务在预算耗尽时收尾，返回结果里应当有未解决事项列表。

## 常见错误

第一个错误是按角色名称划分。角色名称不改变行为，改变行为的是上下文内容与工具白名单。

第二个错误是任务说明引用主对话内容。子智能体看不到这些内容，会按错误的理解执行。

第三个错误是回传完整过程。主上下文被中间过程填满，隔离的收益被抵消。

第四个错误是子任务各自使用独立预算。嵌套之后总消耗远超预期。

第五个错误是并行写入同一工作目录。改动互相覆盖。

第六个错误是把子智能体报告的完成当作完成。没有验收与门禁时，报告与实际状态之间没有约束关系。