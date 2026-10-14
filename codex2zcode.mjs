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
import { readdirSync, statSync, copyFileSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { parseRollout } from "./lib/rollout.mjs";
import { mapRolloutFile } from "./lib/mapper.mjs";
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
  --max-tool-output N 单条工具输出保留字符数,0 为不截断(默认 32768)
  --manifest <path>   增量导入清单(默认 ~/.codex2zcode-manifest.json)
  --force             忽略 manifest,强制重导
  --dry-run           只解析映射,不写入`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { _: [], codexDir: DEFAULTS.codexDir, cliDb: DEFAULTS.cliDb, taskDb: DEFAULTS.taskDb, dryRun: false, limit: Infinity, maxToolOutput: 32768, manifest: join(homedir(), ".codex2zcode-manifest.json"), force: false };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (i === 0 && ["scan", "import", "rollback"].includes(item)) { args._.push(item); continue; }
    if (item === "--dry-run") { args.dryRun = true; continue; }
    if (item === "--all") { args.all = true; continue; }
    if (item === "--force") { args.force = true; continue; }
    if (item === "-h" || item === "--help") usage();
    const next = argv[++i];
    if (next === undefined) throw new Error(`缺少参数值: ${item}`);
    if (item === "--session") args.session = next;
    else if (item === "--project") args.project = next;
    else if (item === "--limit") args.limit = Number(next);
    else if (item === "--max-tool-output") args.maxToolOutput = Number(next);
    else if (item === "--manifest") args.manifest = next;
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

const TOOL_VERSION = "1.5.0";

function cmdImport(args) {
  const files = selectFiles(args);
  console.log(`选中 ${files.length} 个会话${args.dryRun ? "(dry-run)" : ""}\n`);

  // 增量清单:mtime+size+档位+工具版本一致则跳过(源文件是追加式,足够可靠)。
  let manifest = {};
  if (!args.dryRun) {
    try {
      manifest = JSON.parse(readFileSync(args.manifest, "utf8"));
    } catch {
      manifest = {};
    }
  }
  let skipped = 0;
  let dirty = false;

  let cliDb = null;
  let taskDb = null;
  let modelSelection = null;
  let defaultTools = {};
  const results = [];

  for (const file of files) {
    const rel = file.slice(args.codexDir.length + 1);
    try {
      const st = statSync(file);
      const m = manifest[file];
      if (
        !args.force && m && m.mtimeMs === st.mtimeMs && m.size === st.size &&
        m.maxToolOutput === args.maxToolOutput && m.toolVersion === TOOL_VERSION
      ) {
        skipped++;
        continue;
      }
      const parsed = parseRollout(file);
      const sessions = mapRolloutFile(parsed, { maxToolOutput: args.maxToolOutput, defaultTools });
      for (const mapped of sessions) {
        const summary = {
          file: rel,
          archive: mapped.archive,
          codexId: mapped.codexId,
          cwd: mapped.cwd,
          title: mapped.sessionRow.title,
          messages: mapped.messages.length,
          parts: mapped.messages.reduce((a, m2) => a + m2.parts.length, 0),
        };
        if (args.dryRun) {
          results.push({ ...summary, status: "dry-run" });
          console.log(`[dry-run] ${rel} → ${summary.messages} 条消息「${summary.title}」`);
          continue;
        }
        if (!cliDb) {
          cliDb = openDb(args.cliDb);
          taskDb = openDb(args.taskDb);
          verifySchema(cliDb, taskDb);
          console.log(`备份: ${backupDb(args.cliDb)}`);
          console.log(`备份: ${backupDb(args.taskDb)}`);
          try {
            modelSelection = JSON.parse(
              cliDb.prepare("SELECT data FROM session_entry WHERE type='runtime/model_selection' ORDER BY time_updated DESC LIMIT 1").get()?.data ?? "{}",
            ).modelSelection ?? null;
          } catch {}
          try {
            const toolsRow = cliDb.prepare("SELECT json_extract(data,'$.tools') AS t FROM message WHERE json_extract(data,'$.tools') IS NOT NULL AND json_type(json_extract(data,'$.tools'))='object' AND length(json_extract(data,'$.tools'))>10 ORDER BY time_created DESC LIMIT 1").get();
            if (toolsRow?.t) defaultTools = JSON.parse(toolsRow.t);
          } catch {}
        }
        const written = importSession(cliDb, taskDb, mapped, { modelSelection });
        results.push({ ...summary, ...written, status: "ok" });
        console.log(`[ok] ${rel} → ${written.messageCount} 消息 / ${written.partCount} parts「${summary.title}」`);
      }
      if (!args.dryRun) {
        manifest[file] = { mtimeMs: st.mtimeMs, size: st.size, maxToolOutput: args.maxToolOutput, toolVersion: TOOL_VERSION, at: Date.now() };
        dirty = true;
      }
    } catch (error) {
      results.push({ file: rel, status: "failed", error: String(error?.message || error) });
      console.error(`[fail] ${rel}: ${error?.message || error}`);
    }
  }

  if (cliDb) { cliDb.close(); taskDb.close(); }
  if (dirty) writeFileSync(args.manifest, JSON.stringify(manifest, null, 1));

  const ok = results.filter((r) => r.status === "ok").length;
  const failed = results.filter((r) => r.status === "failed");
  const reportPath = `codex2zcode-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  if (!args.dryRun && (results.length || skipped)) {
    writeFileSync(reportPath, JSON.stringify({ args: { ...args, _: undefined }, results }, null, 2));
  }
  console.log(`\n完成:成功 ${ok} 个会话 / ${files.length} 个文件${skipped ? `,manifest 跳过 ${skipped}` : ""}${failed.length ? `,失败 ${failed.length}` : ""}${!args.dryRun ? `,报告: ${reportPath}` : ""}`);
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
