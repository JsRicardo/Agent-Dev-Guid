import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const [, , mode, bookDir, parentNodeToken] = process.argv;

if (!mode || !bookDir || !parentNodeToken) {
  console.error("用法：node feishu-upload.mjs <create-readme|create-lessons> <bookDir> <parentNodeToken>");
  process.exit(1);
}

function chapters() {
  return readdirSync(bookDir)
    .filter((name) => statSync(join(bookDir, name)).isDirectory())
    .sort();
}

function lessonFiles(chapter) {
  return readdirSync(join(bookDir, chapter))
    .filter((name) => name.endsWith(".md"))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
}

function splitTitle(markdown) {
  const lines = markdown.split("\n");
  const index = lines.findIndex((line) => /^#\s+/.test(line));
  if (index === -1) return { title: null, body: markdown };
  const heading = lines[index].replace(/^#\s+/, "").trim();
  const matched = /^(\d+)\s*·\s*(.+)$/.exec(heading);
  const title = matched
    ? `${matched[1].padStart(2, "0")} · ${matched[2].trim()}`
    : heading;
  const body = [...lines.slice(0, index), ...lines.slice(index + 1)].join("\n");
  return { title, body };
}

function extractJson(text) {
  const start = text.indexOf("\n{");
  const raw = start === -1 ? (text.trim().startsWith("{") ? text.trim() : "") : text.slice(start + 1);
  if (!raw) throw new Error(`没有找到 JSON 输出：${text.slice(0, 300)}`);
  return JSON.parse(raw);
}

function create(title, body) {
  const args = [
    "docs",
    "+create",
    "--doc-format",
    "markdown",
    "--content",
    "-",
    "--title",
    title,
    "--parent-token",
    parentNodeToken,
    "--as",
    "user",
  ];

  const result = spawnSync("lark-cli", args, {
    input: body,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });

  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0 && !combined.includes('"ok"')) {
    return { ok: false, error: `退出码 ${result.status}：${combined.slice(-400)}` };
  }

  try {
    const payload = extractJson(combined);
    if (payload.ok === true) {
      return { ok: true, documentId: payload.data?.document?.document_id, url: payload.data?.document?.url };
    }
    const error = payload.error ?? {};
    return { ok: false, error: `${error.subtype ?? "unknown"} ${error.code ?? ""} ${error.message ?? ""}` };
  } catch (error) {
    return { ok: false, error: `${error instanceof Error ? error.message : String(error)}` };
  }
}

async function createWithRetry(title, body) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const result = await create(title, body);
    if (result.ok) return result;
    const retryable = /rate_limit|99991400|too many request/i.test(result.error);
    if (!retryable || attempt === 4) return result;
    const wait = 2000 * attempt;
    console.error(`  重试 ${attempt}/4（等待 ${wait} 毫秒）：${result.error}`);
    await sleep(wait);
  }
  return { ok: false, error: "重试次数用尽" };
}

async function run() {
  const targets = [];

  if (mode === "create-readme") {
    const markdown = readFileSync(join(bookDir, "README.md"), "utf-8");
    const parsed = splitTitle(markdown);
    targets.push({ label: parsed.title ?? "README", body: parsed.body, title: parsed.title ?? "README", isBook: true });
  } else if (mode === "create-lessons") {
    for (const chapter of chapters()) {
      for (const file of lessonFiles(chapter)) {
        const markdown = readFileSync(join(bookDir, chapter, file), "utf-8");
        const parsed = splitTitle(markdown);
        targets.push({ label: `${chapter}/${file}`, body: parsed.body, title: parsed.title ?? file.replace(/\.md$/, "") });
      }
    }
  } else {
    throw new Error(`未知模式：${mode}`);
  }

  let ok = 0;
  let failed = 0;

  for (const target of targets) {
    const result = await createWithRetry(target.title, target.body);
    if (result.ok) {
      ok++;
      console.log(`[成功] ${target.title}  ${result.url ?? ""}  ${result.documentId ?? ""}`);
      if (target.isBook) console.log(`BOOK_DOCUMENT_ID=${result.documentId}`);
    } else {
      failed++;
      console.log(`[失败] ${target.title}（${target.label}）：${result.error}`);
    }
    await sleep(500);
  }

  console.log(`\n合计：成功 ${ok}，失败 ${failed}`);
}

await run();