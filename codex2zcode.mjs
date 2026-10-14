#!/usr/bin/env node
// codex2zcode:把 Codex CLI/Desktop 的会话(rollout JSONL)导入 ZCode 会话库与任务索引。
// 零第三方依赖(Node >= 22.5,使用内置 node:sqlite)。
//
// 用法:
//   node codex2zcode.mjs scan [--codex-dir <dir>]
//   node codex2zcode.mjs import (--session <uuid片段> | --project <cwd片段> | --all)
//                               [--limit N] [--dry-run] [--codex-dir <dir>]
//                               [--db <cli-db路径>] [--tasks <tasks-index路径>]
//   node codex2zcode.mjs rollback --backup <备份文件> --db <目标库路径>
import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, statSync, copyFileSync, existsSync, writeFileSync } from "node:fs";
import { parseRollout } from "./lib/rollout.mjs";
import { mapSession } from "./lib/mapper.mjs";
import { backupDb, openDb, verifySchema, importSession, sessionExists } from "./lib/zcode-db.mjs";

const DEFAULTS = {
  codexDir: join(homedir(), ".codex", "sessions"),
  cliDb: join(homedir(), ".zcode", "cli", "db", "db.sqlite"),
  taskDb: join(homedir(), ".zcode", "v2", "tasks-index.sqlite"),
};

function usage(exitCode = 0) {
  console.log(`codex2zcode — Codex 会话迁移进 ZCode

  scan                                  扫描 Codex 会话,按项目分组统计
  import --session <uuid片段>            导入单个会话
  import --project <cwd片段>             导入某项目的全部会话
  import --all [--limit N]              导入全部(可限流)
  rollback --backup <文件> --db <库>     从备份还原数据库

通用选项:
  --codex-dir <dir>   Codex sessions 目录(默认 ~/.codex/sessions)
  --db <path>         ZCode CLI 会话库(默认 ~/.zcode/cli/db/db.sqlite)
  --tasks <path>      ZCode 任务索引(默认 ~/.zcode/v2/tasks-index.sqlite)
  --dry-run           只解析映射,不写入`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { _: [], codexDir: DEFAULTS.codexDir, cliDb: DEFAULTS.cliDb, taskDb: DEFAULTS.taskDb, dryRun: false, limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (i === 0 && ["scan", "import", "rollback"].includes(item)) { args._.push(item); continue; }
    if (item === "--dry-run") { args.dryRun = true; continue; }
    if (item === "--all") { args.all = true; continue; }
    if (item === "-h" || item === "--help") usage();
    const next = argv[++i];
    if (next === undefined) throw new Error(`缺少参数值: ${item}`);
    if (item === "--session") args.session = next;
    else if (item === "--project") args.project = next;
    else if (item === "--limit") args.limit = Number(next);
    else if (item === "--codex-dir") args.codexDir = next;
    else if (item === "--db") args.cliDb = next;
    else if (item === "--tasks") args.taskDb = next;
    else if (item === "--backup") args.backup = next;
    else if (item === "--to") args.dbTarget = next;
    else throw new Error(`未知选项: ${item}`);
  }
  return args;
}

function listRolloutFiles(codexDir) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (name.startsWith("rollout-") && name.endsWith(".jsonl")) files.push(full);
    }
  };
  walk(codexDir);
  return files.sort();
}

function summarize(parsed) {
  const meta = parsed.meta ?? {};
  return {
    file: parsed.filePath,
    codexId: meta.id || "",
    cwd: meta.cwd || "(未知)",
    originator: meta.originator || "",
    firstTs: parsed.firstTs,
    sizeKb: Math.round(statSync(parsed.filePath).size / 1024),
  };
}

function cmdScan(args) {
  const files = listRolloutFiles(args.codexDir);
  const byProject = new Map();
  let noMeta = 0;
  for (const file of files) {
    let parsed;
    try {
      parsed = parseRollout(file);
    } catch (e) {
      noMeta++;
      continue;
    }
    const s = summarize(parsed);
    if (!byProject.has(s.cwd)) byProject.set(s.cwd, []);
    byProject.get(s.cwd).push(s);
  }
  const projects = [...byProject.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [cwd, sessions] of projects) {
    const dates = sessions.map((s) => new Date(s.firstTs).toISOString().slice(0, 10)).sort();
    console.log(`${String(sessions.length).padStart(4)} 个会话  ${cwd}`);
    console.log(`          ${dates[0]} ~ ${dates[dates.length - 1]},共 ${Math.round(sessions.reduce((a, s) => a + s.sizeKb, 0) / 1024)} MB`);
  }
  console.log(`\n合计:${files.length} 个 rollout 文件,${projects.length} 个项目${noMeta ? `,${noMeta} 个解析失败` : ""}`);
}

function selectFiles(args) {
  const files = listRolloutFiles(args.codexDir);
  if (args.session) {
    const hit = files.filter((f) => f.includes(args.session));
    if (hit.length === 0) throw new Error(`没有匹配 --session ${args.session} 的会话文件`);
    return hit;
  }
  if (args.project) {
    const summaries = files.map((f) => {
      try {
        return { f, meta: parseRollout(f).meta ?? {} };
      } catch {
        return { f, meta: null };
      }
    });
    const hit = summaries.filter((s) => s.meta?.cwd?.includes(args.project)).map((s) => s.f);
    if (hit.length === 0) throw new Error(`没有匹配 --project ${args.project} 的会话`);
    return hit.slice(0, args.limit);
  }
  if (args.all) return files.slice(0, args.limit);
  throw new Error("需要 --session / --project / --all 之一");
}

function cmdImport(args) {
  const files = selectFiles(args);
  console.log(`选中 ${files.length} 个会话${args.dryRun ? "(dry-run)" : ""}\n`);

  let cliDb = null;
  let taskDb = null;
  let backedUp = false;
  const results = [];

  for (const file of files) {
    const rel = file.slice(args.codexDir.length + 1);
    try {
      const parsed = parseRollout(file);
      const mapped = mapSession(parsed);
      const summary = {
        file: rel,
        codexId: mapped.codexId,
        cwd: mapped.cwd,
        title: mapped.sessionRow.title,
        messages: mapped.messages.length,
        parts: mapped.messages.reduce((a, m) => a + m.parts.length, 0),
      };
      if (args.dryRun) {
        results.push({ ...summary, status: "dry-run" });
        console.log(`[dry-run] ${rel} → ${mapped.messages.length} 条消息,标题:「${summary.title}」`);
        continue;
      }
      if (!cliDb) {
        cliDb = openDb(args.cliDb);
        taskDb = openDb(args.taskDb);
        verifySchema(cliDb, taskDb);
        console.log(`备份: ${backupDb(args.cliDb)}`);
        console.log(`备份: ${backupDb(args.taskDb)}`);
        backedUp = true;
      }
      if (sessionExists(cliDb, mapped.sessionId)) {
        // 幂等重导入:清旧消息重写,视为更新
      }
      const written = importSession(cliDb, taskDb, mapped);
      results.push({ ...summary, ...written, status: "ok" });
      console.log(`[ok] ${rel} → ${written.messageCount} 消息 / ${written.partCount} parts「${summary.title}」`);
    } catch (error) {
      results.push({ file: rel, status: "failed", error: String(error?.message || error) });
      console.error(`[fail] ${rel}: ${error?.message || error}`);
    }
  }

  if (cliDb) { cliDb.close(); taskDb.close(); }

  const ok = results.filter((r) => r.status === "ok").length;
  const failed = results.filter((r) => r.status === "failed");
  const reportPath = `codex2zcode-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  if (!args.dryRun) {
    writeFileSync(reportPath, JSON.stringify({ args: { ...args, _: undefined }, results }, null, 2));
  }
  console.log(`\n完成:成功 ${ok} / ${files.length}${failed.length ? `,失败 ${failed.length}` : ""}${!args.dryRun ? `,报告: ${reportPath}` : ""}`);
  if (failed.length) process.exitCode = 2;
}

function cmdRollback(args) {
  if (!args.backup || !args.dbTarget) usage(1);
  if (!existsSync(args.backup)) throw new Error(`备份不存在: ${args.backup}`);
  copyFileSync(args.backup, args.dbTarget);
  console.log(`已还原 ${args.dbTarget} ← ${args.backup}`);
}

function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (!subcommand) usage();
  const args = parseArgs([subcommand, ...rest]);
  const command = args._[0];
  if (command === "scan") cmdScan(args);
  else if (command === "import") cmdImport(args);
  else if (command === "rollback") cmdRollback(args);
  else usage(1);
}

try {
  main();
} catch (error) {
  console.error(`错误: ${error?.message || error}`);
  process.exit(1);
}
