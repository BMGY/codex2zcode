// ZCode 侧写入器:WAL 安全备份、schema 校验、双库事务写入(幂等)。
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const originalEmitWarning = process.emitWarning;
process.emitWarning = function filterSqliteExperimentalWarning(warning, ...args) {
  if (String(warning).includes("SQLite is an experimental feature")) return;
  return originalEmitWarning.call(process, warning, ...args);
};
const { DatabaseSync } = await import("node:sqlite");
process.emitWarning = originalEmitWarning;

const SESSION_REQUIRED_COLUMNS = [
  "id", "project_id", "workspace_id", "slug", "directory", "path", "title", "version",
  "time_created", "time_updated", "task_type", "title_source", "trace_id",
];
const TASKS_REQUIRED_COLUMNS = [
  "workspace_key", "workspace_path", "task_id", "title", "provider", "mode",
  "created_at", "updated_at", "meta_json", "searchable_text",
];

// sqlite3 CLI 的 .backup 会正确处理 WAL(比直接 copyFileSync 主文件安全)。
export function backupDb(dbPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${dbPath}.bak-${stamp}`;
  execFileSync("sqlite3", [dbPath, `.backup "${dest}"`], { stdio: "pipe" });
  return dest;
}

export function openDb(dbPath) {
  if (!existsSync(dbPath)) throw new Error(`数据库不存在: ${dbPath}`);
  let db;
  try {
    db = new DatabaseSync(dbPath, { timeout: 30000 });
  } catch {
    db = new DatabaseSync(dbPath);
  }
  try {
    db.exec("PRAGMA busy_timeout = 30000");
  } catch {
    // 个别版本 exec 对返回行的 pragma 报错,忽略(构造参数已尽力设置)。
  }
  return db;
}

export function verifySchema(cliDb, taskDb) {
  const sessionCols = new Set(
    cliDb.prepare("PRAGMA table_info(session)").all().map((c) => c.name),
  );
  for (const col of SESSION_REQUIRED_COLUMNS) {
    if (!sessionCols.has(col)) throw new Error(`cli db session 表缺少列 ${col},schema 已漂移,中止`);
  }
  const taskCols = new Set(
    taskDb.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name),
  );
  for (const col of TASKS_REQUIRED_COLUMNS) {
    if (!taskCols.has(col)) throw new Error(`tasks-index tasks 表缺少列 ${col},schema 已漂移,中止`);
  }
}

export function sessionExists(cliDb, sessionId) {
  return cliDb.prepare("SELECT 1 FROM session WHERE id = ?").get(sessionId) != null;
}

// 会话行 upsert:已存在(如重导入)时保留用户自定义标题。SQL 形状对齐官方 restore 插件。
function upsertSessionRow(cliDb, s) {
  cliDb
    .prepare(`
      INSERT INTO session
        (id, project_id, workspace_id, slug, directory, path, title, version,
         time_created, time_updated, task_type, title_source, trace_id)
      VALUES
        (@id, @project_id, @workspace_id, @slug, @directory, @path, @title, @version,
         @time_created, @time_updated, @task_type, @title_source, @trace_id)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        workspace_id = excluded.workspace_id,
        slug = excluded.slug,
        directory = excluded.directory,
        path = excluded.path,
        title = CASE WHEN session.title_source = 'custom' THEN session.title ELSE excluded.title END,
        version = excluded.version,
        time_created = MIN(session.time_created, excluded.time_created),
        time_updated = MAX(session.time_updated, excluded.time_updated),
        task_type = excluded.task_type,
        trace_id = COALESCE(session.trace_id, excluded.trace_id)
    `)
    .run(s);
}

function upsertTaskRow(taskDb, t) {
  taskDb
    .prepare(`
      INSERT INTO tasks
        (workspace_key, workspace_path, workspace_identity, task_id, title,
         task_status, provider, mode, model, migration_source, forked_from_task_id,
         created_at, updated_at, unread_at, meta_json, searchable_text)
      VALUES
        (@workspace_key, @workspace_path, @workspace_identity, @task_id, @title,
         @task_status, @provider, @mode, @model, NULL, @forked_from_task_id,
         @created_at, @updated_at, @unread_at, @meta_json, @searchable_text)
      ON CONFLICT(workspace_key, task_id) DO UPDATE SET
        workspace_path = excluded.workspace_path,
        workspace_identity = excluded.workspace_identity,
        title = CASE WHEN tasks.title_overridden = 1 THEN tasks.title ELSE excluded.title END,
        task_status = excluded.task_status,
        provider = excluded.provider,
        mode = excluded.mode,
        model = excluded.model,
        migration_source = NULL,
        forked_from_task_id = excluded.forked_from_task_id,
        created_at = MIN(tasks.created_at, excluded.created_at),
        updated_at = MAX(tasks.updated_at, excluded.updated_at),
        unread_at = tasks.unread_at,
        searchable_text = CASE
          WHEN tasks.updated_at > excluded.updated_at THEN tasks.searchable_text
          ELSE excluded.searchable_text
        END,
        meta_json = excluded.meta_json
    `)
    .run(t);
}

// 单会话双库事务写入。合并式幂等:只清掉本工具先前导入的消息(msg_cx_<id>_%),
// 保留用户导入后在 ZCode 里续聊产生的原生消息(它们的 parentID 引用确定性 id,链不断)。
// 对运行中的 ZCode 安全:WAL + busy_timeout + 短事务 + 忙锁重试。
export function importSession(cliDb, taskDb, mapped, { retries = 3, modelSelection = null } = {}) {
  const { sessionRow, taskRow, messages, codexId, msgIdPrefix, staleSessionIds = [] } = mapped;
  // 归档会话的 idScope 是 <codexId>arc,必须用 mapper 传来的准确前缀,否则清不到旧归档行。
  const msgPrefix = msgIdPrefix ?? `msg_cx_${codexId}_`;
  const insertMessage = cliDb.prepare(`
    INSERT OR REPLACE INTO message (id, session_id, time_created, time_updated, data, sequence)
    VALUES (@id, @session_id, @time_created, @time_updated, @data, @sequence)
  `);
  const insertPart = cliDb.prepare(`
    INSERT OR REPLACE INTO part (id, message_id, session_id, time_created, time_updated, data, sequence)
    VALUES (@id, @message_id, @session_id, @time_created, @time_updated, @data, @sequence)
  `);

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    let cliInTx = false;
    let taskInTx = false;
    try {
      taskDb.exec("BEGIN IMMEDIATE");
      taskInTx = true;
      cliDb.exec("BEGIN IMMEDIATE");
      cliInTx = true;

      cliDb
        .prepare("DELETE FROM part WHERE session_id = ? AND message_id LIKE ?")
        .run(sessionRow.id, `${msgPrefix}%`);
      cliDb
        .prepare("DELETE FROM message WHERE session_id = ? AND id LIKE ?")
        .run(sessionRow.id, `${msgPrefix}%`);

      // 续聊保护:用户在 ZCode 里追加的原生消息重排到导入历史之后,采用紧邻连续编号——
      // 序号断档会让 UI 虚拟滚动的定位/跳底落在错误区间(表现为"看不到后面的消息")。
      const natives = cliDb
        .prepare("SELECT id FROM message WHERE session_id = ? AND id NOT LIKE ? ORDER BY sequence")
        .all(sessionRow.id, `${msgPrefix}%`);
      if (natives.length > 0) {
        const renumber = cliDb.prepare("UPDATE message SET sequence = ? WHERE session_id = ? AND id = ?");
        for (const [i, row] of natives.entries()) {
          renumber.run(messages.length + i, sessionRow.id, row.id);
        }
      }

      upsertSessionRow(cliDb, sessionRow);
      let partCount = 0;
      for (const msg of messages) {
        insertMessage.run({
          id: msg.id,
          session_id: sessionRow.id,
          time_created: msg.ts,
          time_updated: msg.ts,
          data: JSON.stringify(msg.data),
          sequence: msg.seq,
        });
        for (const [partIndex, part] of msg.parts.entries()) {
          insertPart.run({
            id: `${msg.id}_${String(partIndex).padStart(4, "0")}`,
            message_id: msg.id,
            session_id: sessionRow.id,
            time_created: part.ts,
            time_updated: part.ts,
            data: JSON.stringify(part.data),
            sequence: partIndex,
          });
          partCount++;
        }
      }

      upsertTaskRow(taskDb, taskRow);

      // 清理旧版双会话方案遗留的归档会话(仅当其中没有用户续聊的原生消息时才删)。
      for (const staleId of staleSessionIds) {
        const staleNative = cliDb
          .prepare("SELECT COUNT(*) AS n FROM message WHERE session_id = ? AND id NOT LIKE 'msg_cx_%'")
          .get(staleId).n;
        if (staleNative === 0) {
          cliDb.prepare("DELETE FROM session WHERE id = ?").run(staleId);
          taskDb.prepare("DELETE FROM tasks WHERE task_id = ?").run(staleId);
        }
      }

      // session_entry 补写:模型选择/执行状态让迁移会话打开时即用默认模型;
      // 每个压缩点补一条 v4/command_fact(对齐原生压缩的时间线渲染契约)。
      const insertEntry = cliDb.prepare(`
        INSERT OR REPLACE INTO session_entry (id, session_id, type, time_created, time_updated, data)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const entryNow = Date.now();
      if (modelSelection) {
        insertEntry.run(
          `${sessionRow.id}:runtime-model-selection`, sessionRow.id, "runtime/model_selection",
          entryNow, entryNow, JSON.stringify({ modelSelection }),
        );
      }
      insertEntry.run(
        `${sessionRow.id}:runtime-execution-state`, sessionRow.id, "runtime/execution_state",
        entryNow, entryNow, JSON.stringify({ mode: "build", planEnabled: false }),
      );
      for (const fact of mapped.compactionFacts ?? []) {
        insertEntry.run(
          `v4_command_fact:timeline:${fact.commandId}`, sessionRow.id, "v4/command_fact",
          fact.ts, fact.ts,
          JSON.stringify({
            source: "timeline",
            ack: { commandId: fact.commandId, status: "accepted", revisionAtDecision: 0 },
            metadata: { lifecycleStatus: "success" },
          }),
        );
      }

      cliDb.exec("COMMIT");
      cliInTx = false;
      taskDb.exec("COMMIT");
      taskInTx = false;
      return { messageCount: messages.length, partCount };
    } catch (error) {
      if (cliInTx) {
        try {
          cliDb.exec("ROLLBACK");
        } catch {}
      }
      if (taskInTx) {
        try {
          taskDb.exec("ROLLBACK");
        } catch {}
      }
      lastError = error;
      const busy = String(error?.message || "").toLowerCase().includes("locked");
      if (!busy || attempt === retries) break;
    }
  }
  throw lastError;
}
