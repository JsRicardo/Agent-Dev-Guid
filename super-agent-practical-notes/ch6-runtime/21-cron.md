# 21 · Cron 定时任务系统

> 章节：第六章 权限 + Cron + Multi-Agent

## 本讲目标

让 Agent 在没有使用者提问时也能干活。这一讲结束时，可以用自然语言创建定时任务，任务定义可以热更新，错过触发与执行超时都有明确的处理方式，每次运行留下记录。

## 要写的代码

```
src/cron/
├── types.ts
├── store.ts        任务定义与运行记录
├── scheduler.ts    调度循环
└── runner.ts       触发一次运行
```

### 任务定义

```typescript
export type Schedule = 
  | { type: "at"; at: string }
  | { type: "every"; every: string }
  | { type: "cron"; expression: string; timezone?: string };

export type Job = {
  id: string;
  name: string;
  schedule: Schedule;
  prompt: string;
  cwd: string;
  channel?: string;
  enabled: boolean;
  catchUp: "none" | "latest";
  overlap: "skip" | "queue";
  createdAt: string;
  lastRunAt?: string;
  lastStatus?: "ok" | "failed" | "skipped";
};

export type RunRecord = {
  jobId: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "ok" | "failed" | "skipped";
  summary?: string;
  tokens?: { input: number; output: number };
};
```

三个字段的取值需要明确：`catchUp` 决定错过的触发如何处理，`overlap` 决定上一次还没跑完时下一次怎么办，`enabled` 决定任务是否生效。这三处不写清楚，定时任务会在第一次异常之后出现难以解释的行为。

### 存储与热更新

```typescript
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class JobStore {
  private jobs: Job[] = [];
  private runs: RunRecord[] = [];

  constructor(private readonly dir: string) {}

  get jobsPath(): string {
    return join(this.dir, "jobs.json");
  }

  get runsPath(): string {
    return join(this.dir, "runs.jsonl");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.jobsPath, "utf-8");
      this.jobs = JSON.parse(raw) as Job[];
    } catch {
      this.jobs = [];
    }
  }

  list(): Job[] {
    return this.jobs.filter((job) => job.enabled);
  }

  find(id: string): Job | undefined {
    return this.jobs.find((job) => job.id === id);
  }

  async upsert(job: Job): Promise<void> {
    const index = this.jobs.findIndex((item) => item.id === job.id);
    if (index >= 0) this.jobs[index] = job;
    else this.jobs.push(job);
    await this.persistJobs();
  }

  async remove(id: string): Promise<boolean> {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((job) => job.id !== id);
    if (this.jobs.length === before) return false;
    await this.persistJobs();
    return true;
  }

  async recordRun(record: RunRecord): Promise<void> {
    this.runs.push(record);
    await appendFile(this.runsPath, `${JSON.stringify(record)}\n`, "utf-8");
  }

  recentRuns(jobId: string, limit = 10): RunRecord[] {
    return this.runs.filter((run) => run.jobId === jobId).slice(-limit);
  }

  private async persistJobs(): Promise<void> {
    const temp = `${this.jobsPath}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.jobs, null, 2)}\n`, "utf-8");
    await rename(temp, this.jobsPath);
  }
}
```

任务定义用临时文件加改名的方式写入，运行记录用追加方式写入。前者要求整体一致，后者要求中断安全。

### 调度循环

```typescript
import { parseExpression } from "cron-parser";
import { readFile } from "node:fs/promises";

const TICK_MS = 20_000;

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = new Set<string>();
  private lastChecked = Date.now();

  constructor(
    private readonly store: JobStore,
    private readonly run: (job: Job) => Promise<{ status: "ok" | "failed"; summary: string; tokens?: RunRecord["tokens"] }>,
    private readonly notify: (text: string) => Promise<void>,
  ) {}

  async start(): Promise<void> {
    await this.store.load();
    this.lastChecked = Date.now();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 任务定义可以在运行中修改，每个节拍重新读取一次。 */
  async reload(): Promise<void> {
    await this.store.load();
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const jobs = this.store.list();

    for (const job of jobs) {
      const due = this.isDue(job, this.lastChecked, now);
      if (!due.due) continue;

      if (this.running.has(job.id)) {
        if (job.overlap === "skip") {
          await this.store.recordRun({ jobId: job.id, startedAt: new Date().toISOString(), status: "skipped", summary: "上一次运行尚未结束" });
          continue;
        }
      }

      this.running.add(job.id);
      void this.execute(job).finally(() => this.running.delete(job.id));
    }

    this.lastChecked = now;
  }

  private isDue(job: Job, from: number, to: number): { due: boolean } {
    if (job.schedule.type === "every") {
      const intervalMs = parseDuration(job.schedule.every);
      const last = job.lastRunAt ? Date.parse(job.lastRunAt) : Date.parse(job.createdAt);
      return { due: to - last >= intervalMs };
    }
    if (job.schedule.type === "at") {
      const target = Date.parse(job.schedule.at);
      return { due: target > from && target <= to };
    }
    const expression = parseExpression(job.schedule.expression, {
      currentDate: new Date(from),
      tz: job.schedule.timezone,
    });
    const next = expression.next().getTime();
    return { due: next <= to };
  }

  private async execute(job: Job): Promise<void> {
    const startedAt = new Date().toISOString();
    try {
      const outcome = await this.run(job);
      await this.store.recordRun({ jobId: job.id, startedAt, finishedAt: new Date().toISOString(), ...outcome });
      job.lastRunAt = new Date().toISOString();
      job.lastStatus = outcome.status;
      await this.store.upsert(job);
      if (outcome.status === "failed") {
        await this.notify(`任务「${job.name}」执行失败：${outcome.summary}`);
      }
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      await this.store.recordRun({ jobId: job.id, startedAt, finishedAt: new Date().toISOString(), status: "failed", summary });
      await this.notify(`任务「${job.name}」执行异常：${summary}`);
    }
  }
}

function parseDuration(text: string): number {
  const match = /^(\d+)(s|m|h|d|w)$/.exec(text.trim());
  if (!match) throw new Error(`无法解析的周期：${text}`);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2] as "s" | "m" | "h" | "d" | "w"];
  return Number(match[1]) * unit;
}
```

三个关键点：每个节拍重新读取任务定义，因此修改无需重启；上一次未结束时按 `overlap` 处理，默认跳过；失败时主动通知，不依赖使用者事后翻记录。

### 触发一次运行

```typescript
export function createJobRunner(deps: {
  runAgent: (input: { prompt: string; cwd: string; maxTokens: number }) => Promise<{ text: string; tokens: { input: number; output: number } }>;
  sendToChannel: (channel: string, text: string) => Promise<void>;
}) {
  return async (job: Job) => {
    const result = await deps.runAgent({
      prompt: job.prompt,
      cwd: job.cwd,
      maxTokens: 120_000,
    });

    if (job.channel) {
      await deps.sendToChannel(job.channel, result.text);
    }
    return {
      status: "ok" as const,
      summary: result.text.slice(0, 500),
      tokens: result.tokens,
    };
  };
}
```

定时任务复用同一套循环与工具层，区别只在于输入来自配置。任务需要频道时走第 19 讲的 Channel 接口，不需要时把结果写入日志。

### 用自然语言创建任务

```typescript
export function registerScheduleTool(deps: { store: JobStore; reload: () => Promise<void> }) {
  registerTool({
    name: "schedule_manage",
    description:
      "管理定时任务。action 取 create、list、update、remove、history 之一。",
    snippet: "创建和管理定时任务",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "list", "update", "remove", "history"] },
        name: { type: "string", description: "任务名称" },
        every: { type: "string", description: "周期，例如 30m、6h、2d、1w" },
        cron: { type: "string", description: "cron 表达式，与 every 二者取一" },
        timezone: { type: "string", description: "时区，例如 Asia/Shanghai" },
        prompt: { type: "string", description: "每次触发要让 Agent 做的事情" },
        catchUp: { type: "string", enum: ["none", "latest"] },
        overlap: { type: "string", enum: ["skip", "queue"] },
        cwd: { type: "string", description: "工作目录" },
        channel: { type: "string", description: "结果发送到哪个会话" },
      },
      required: ["action"],
    },
    async execute(args) {
      if (args.action === "create") {
        const job: Job = {
          id: randomUUID().slice(0, 8),
          name: args.name ?? "未命名任务",
          schedule: args.cron ? { type: "cron", expression: args.cron, timezone: args.timezone } : { type: "every", every: args.every ?? "1h" },
          prompt: args.prompt ?? "",
          cwd: args.cwd ?? process.cwd(),
          channel: args.channel,
          enabled: true,
          catchUp: args.catchUp ?? "latest",
          overlap: args.overlap ?? "skip",
          createdAt: new Date().toISOString(),
        };
        await deps.store.upsert(job);
        await deps.reload();
        return { content: `已创建任务 ${job.name}（${job.id}）`, details: { id: job.id } };
      }
      // list、update、remove、history 分支
      return { content: "已完成操作" };
    },
  });
}
```

任务的创建、修改、删除都通过工具完成，模型据此可以把使用者的一段描述转成一个任务定义。`history` 这个动作很重要：定时任务出问题时，第一步是看运行记录。

### 错过的触发

进程在停机期间错过的触发按 `catchUp` 处理：取 `none` 表示跳过，取 `latest` 表示只在启动时补执行最近一次。补执行多条会让进程一启动就同时跑几个任务，资源竞争明显。

## pi 的做法

**调度参数。** `pi-subagents` 的 `schedule.create` 支持按延迟（`at`，例如 `+10m`）或按周期（`every`，例如 `30m`、`6h`、`2d`、`2w`）创建运行，另有 `timezone`、`overlap`（只支持 `skip`）、`catchUp`（`none` 或 `latest`）三个选项。讲义里的取值与它一致。

**后台运行与通知。** 后台子智能体运行在独立进程里，脱离发起会话之后继续执行，完成时主动唤醒发起会话。这一处与定时任务是同一条路径：定时任务本质上就是「无人触发的一次后台运行」。讲义里的 `notify` 对应这一条。

**任务触发即开话题。** pi 的实践方式是把一次触发做成一次新的会话，复用前面所有链路：会话、工具、权限、Trace。这比在调度器里直接调用模型更好，因为运行过程与人工提问的运行过程完全一致，排查问题不需要两套思路。

**记录位置。** 后台运行会写 `status.json`、`events.jsonl` 与日志，另有运行历史汇总文件。查看用两个视图：当前状态与历史过程。第 24 讲会给出对应的实现。

**失败的处理方式。** 文档明确规定：工作流、子进程启动、提示词运行时、扩展加载、子工具链的失败属于运行环境故障，应当停止并报告确切的失败与运行标识，改用其他执行方式会掩盖真实故障。定时任务同样需要这条规则：环境问题需要人工处理，反复重试只会让失败记录堆满。

## 验收

1. 用自然语言让 Agent 创建一个每分钟执行一次的任务，任务出现在任务文件里，两分钟后运行记录里出现两条记录。
2. 把周期从一分钟改成两分钟，不重启进程，下一次触发的间隔随之变化。
3. 让任务执行一个必然失败的操作，运行记录里状态为失败，并且收到一条通知。
4. 让任务执行时间超过一个周期，`overlap` 为跳过时应当出现状态为跳过的记录。

## 常见错误

第一个错误是任务定义只在启动时读取。修改之后必须重启才生效，实际使用中无法接受。

第二个错误是不处理重复触发。上一次还没结束时下一次又启动，同一个任务并发运行。

第三个错误是不限制补执行数量。停机一天之后一启动就同时跑几十个任务。

第四个错误是运行记录只放内存。进程重启之后历史全丢，排查无依据。

第五个错误是失败不通知。使用者只能靠主动查看记录发现问题。

第六个错误是任务里直接调用模型而不复用会话与权限。运行过程绕过权限判定，也失去了统一的记录。