// Codex rollout 记录 → ZCode session/message/part 行的映射。
// 契约依据:ZCode 官方 restore-legacy-sessions 插件的写入实现(provider 必须 glm、
// user 消息带空 model:{}、tool 时间放 state.time、详情页正文来自 part 表)。
//
// 综合方案:含压缩(compacted)的会话拆成两个 ZCode 会话——
//   主会话:最后一次压缩的摘要 + 之后的对话,严格对齐 Codex resume 语义,续聊上下文干净;
//   归档会话:压缩前的完整原始对话,同工作区可见、可检索、可追溯,不污染续聊上下文。
import { uuidFromFilename } from "./rollout.mjs";

const GLM_PROVIDER = "glm";

export function projectIdFromPath(workspacePath) {
  return "proj_" + workspacePath.replace(/^\//, "").replace(/\//g, "-").toLowerCase();
}

function textFromContent(content) {
  if (Array.isArray(content)) {
    return content
      .filter((c) => typeof c?.text === "string")
      .map((c) => c.text)
      .join("\n");
  }
  return typeof content === "string" ? content : "";
}

function reasoningText(payload) {
  const fromContent = Array.isArray(payload.content)
    ? payload.content
        .filter((c) => c?.type === "reasoning_text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n")
    : "";
  if (fromContent.trim()) return fromContent;
  const fromSummary = Array.isArray(payload.summary)
    ? payload.summary
        .filter((c) => typeof c?.text === "string")
        .map((c) => c.text)
        .join("\n")
    : "";
  return fromSummary;
}

function safeJsonParse(str) {
  if (typeof str !== "string") return undefined;
  try {
    return JSON.parse(str);
  } catch {
    return undefined;
  }
}

// function_call_output 的 output 通常是 JSON 字符串 {"output": "...", "metadata": {...}}
function toolOutputText(raw) {
  if (typeof raw !== "string") return raw == null ? "" : JSON.stringify(raw);
  const parsed = safeJsonParse(raw);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "output" in parsed) {
    const inner = parsed.output;
    return typeof inner === "string" ? inner : JSON.stringify(inner);
  }
  return raw;
}

function mapTokens(usage) {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  return {
    total: usage.total_tokens ?? input + output,
    input,
    output,
    reasoning: usage.reasoning_output_tokens ?? 0,
    cache: { read: usage.cached_input_tokens ?? 0, write: 0 },
  };
}

function zeroTokens() {
  return { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
}

function cleanTitle(text) {
  return text
    .replace(/<[a-zA-Z_][^>]*>[\s\S]*?<\/[a-zA-Z_][^>]*>/g, " ")
    .replace(/<\/?[a-zA-Z_][^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 同名标签配对剥离(environment_context 等内含嵌套标签,通配配对会错切)。
const WRAPPER_TAGS =
  /<(environment_context|user_instructions|permissions|app-context|multi_agent_mode|quiet|sandbox_policy)>([\s\S]*?)<\/\1>/g;

function extractUserText(raw) {
  return raw
    .replace(WRAPPER_TAGS, " ")
    .replace(/<\/?[a-zA-Z_][^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 权限评估轮、JSON 判定输出、桌面端注入上下文都不适合当标题。
function isNoiseUserText(text) {
  if (!text) return true;
  if (text.startsWith("{") || text.startsWith("[")) return true;
  if (/Codex agent history/i.test(text)) return true; // 各类权限评估提示都内嵌这段话
  if (/^The user interrupted the previous turn/i.test(text)) return true; // 系统中断通知
  if (/^# Codex desktop context/.test(text)) return true;
  return false;
}

const TOOL_CALL_ITEM_TYPES = new Set([
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "web_search_call",
]);
const TOOL_OUTPUT_ITEM_TYPES = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "local_shell_call_output",
]);

// 巨型工具输出(截图 base64、全文件转储)会让续聊时重放输入撑爆上下文窗口,
// 统一截断到上限,保头去尾并标注原始大小。
function truncateToolOutput(text, maxBytes) {
  if (!maxBytes || text.length <= maxBytes) return text;
  return (
    text.slice(0, maxBytes) +
    `\n\n[codex2zcode: 工具输出已截断,保留前 ${maxBytes} 字符,原始 ${text.length} 字符]`
  );
}

function compactionSummaryText(payload) {
  if (typeof payload?.message === "string") return payload.message;
  const viaContent = textFromContent(payload?.message?.content);
  if (viaContent.trim()) return viaContent;
  return JSON.stringify(payload?.message ?? {});
}

// 标题:全部记录里第一条有实际内容的用户消息(跳过噪音),退化为首条 assistant 文本。
// 用整个文件(含压缩前)选标题,保证主/归档会话标题同源。
function pickTitle(records) {
  let firstAssistant = "";
  for (const rec of records) {
    if (rec.type !== "response_item" || rec.payload?.type !== "message") continue;
    const p = rec.payload;
    if (p.role === "user") {
      const cleaned = extractUserText(textFromContent(p.content));
      if (!isNoiseUserText(cleaned)) return cleaned.slice(0, 80);
    } else if (!firstAssistant) {
      const cleaned = cleanTitle(textFromContent(p.content));
      if (cleaned) firstAssistant = cleaned.slice(0, 80);
    }
  }
  return firstAssistant;
}

// 单段对话的映射状态机:records → ZCode message/part 列表。
// idScope 决定消息 id 前缀,主会话与归档会话必须不同(message.id 是全局主键)。
function buildConversation({ records, idScope, cwd, parsed, maxToolOutput, initialUser = [] }) {
  const root = cwd;
  const mkMsgId = (i) => `msg_cx_${idScope}_${String(i).padStart(5, "0")}`;

  let currentModel = "codex";
  let lastTokens = null;
  let seq = 0;
  let lastUserMsgId = "";
  let cur = null; // 当前 assistant 段:{parts, texts, toolCalls, tsStart, tsEnd, model}
  const pendingTools = new Map(); // call_id -> tool part data(共享引用,输出稍后回填)
  const messages = [];

  function ensureCur(ts) {
    if (!cur) {
      cur = { parts: [], texts: [], toolCalls: [], tsStart: ts, tsEnd: ts, model: currentModel };
    }
  }

  function pushUserMessage(content, ts, extra = {}) {
    const mi = seq++;
    const mid = mkMsgId(mi);
    const data = {
      role: "user",
      time: { created: ts },
      agent: "zcode-agent",
      content,
      modelSelection: { providerId: GLM_PROVIDER, modelId: currentModel },
      model: {},
    };
    const partData = { type: "text", text: content, time: { start: ts, end: ts } };
    messages.push({ id: mid, seq: mi, role: "user", ts, data, parts: [{ data: partData, ts }], ...extra });
    lastUserMsgId = mid;
    return mid;
  }

  function flushCur(endTs) {
    if (!cur) return;
    const hasContent = cur.parts.length > 0 || cur.texts.length > 0;
    if (hasContent) {
      const mi = seq++;
      const created = cur.tsStart;
      const completed = endTs ?? cur.tsEnd ?? created;
      const hasTool = cur.parts.some((p) => p.data.type === "tool");
      const tokens = lastTokens ?? zeroTokens();
      const parts = [
        { data: { type: "step-start" }, ts: created },
        ...cur.parts,
        {
          data: { type: "step-finish", reason: hasTool ? "tool-calls" : "stop", cost: 0, tokens },
          ts: completed,
        },
      ];
      const data = {
        role: "assistant",
        time: { created, completed },
        agent: "zcode-agent",
        content: cur.texts.join("\n"),
        modelId: cur.model,
        providerId: GLM_PROVIDER,
        mode: "build",
        path: { cwd, root },
        cost: 0,
        tokens,
        finish: hasTool ? "tool-calls" : "stop",
        toolCalls: cur.toolCalls,
      };
      if (lastUserMsgId) data.parentID = lastUserMsgId;
      messages.push({ id: mkMsgId(mi), seq: mi, role: "assistant", ts: created, data, parts });
    }
    cur = null;
  }

  for (const init of initialUser) pushUserMessage(init.text, init.ts);

  const endTs = records.length ? records[records.length - 1].ts || parsed.lastTs : parsed.lastTs;

  for (const rec of records) {
    const ts = rec.ts || parsed.firstTs;
    const p = rec.payload ?? {};

    if (rec.type === "turn_context") {
      if (typeof p.model === "string" && p.model) currentModel = p.model;
      continue;
    }

    if (rec.type === "event_msg") {
      if (p.type === "token_count" && p.info?.last_token_usage) {
        lastTokens = mapTokens(p.info.last_token_usage);
      } else if (p.type === "task_complete") {
        flushCur(ts);
      }
      continue;
    }

    if (rec.type === "compacted") {
      // 归档段内的中间压缩点:保留原始轮次、摘要不落地(与压缩前语义一致)。
      flushCur(ts);
      continue;
    }

    if (rec.type !== "response_item") continue;

    if (p.type === "message") {
      if (p.role === "user") {
        flushCur(ts);
        const content = textFromContent(p.content);
        if (content.trim()) pushUserMessage(content, ts);
      } else if (p.role === "assistant") {
        const content = textFromContent(p.content);
        // 同一轮里 assistant 文本出现在工具调用之后:闭合上一段,另起一段。
        if (cur && (cur.parts.length > 0 || cur.texts.length > 0)) flushCur(ts);
        ensureCur(ts);
        if (content.trim()) {
          cur.texts.push(content);
          cur.parts.push({ data: { type: "text", text: content, time: { start: ts, end: ts } }, ts });
        }
        cur.tsEnd = ts;
      }
      continue;
    }

    if (p.type === "reasoning") {
      const text = reasoningText(p);
      if (!text.trim()) continue;
      ensureCur(ts);
      cur.parts.push({ data: { type: "reasoning", text, time: { start: ts, end: ts } }, ts });
      cur.tsEnd = ts;
      continue;
    }

    if (TOOL_CALL_ITEM_TYPES.has(p.type)) {
      ensureCur(ts);
      const callID = p.call_id || `call_cx_${idScope}_${seq}_${cur.parts.length}`;
      const name = p.type === "web_search_call" ? "web_search" : p.name || p.type;
      let input;
      if (p.type === "function_call") {
        input = safeJsonParse(p.arguments) ?? { raw: p.arguments ?? "" };
      } else if (p.type === "web_search_call" || p.type === "local_shell_call") {
        input = { action: p.action ?? {} };
      } else {
        input = typeof p.input === "string" ? { input: p.input } : p.input ?? {};
      }
      const partData = {
        type: "tool",
        callID,
        tool: name,
        state: { status: "completed", input, output: "", time: { start: ts, end: ts } },
      };
      cur.parts.push({ data: partData, ts });
      const toolCall = { id: callID, toolName: name, kind: "other", status: "completed", input, output: "" };
      cur.toolCalls.push(toolCall);
      pendingTools.set(callID, { partData, toolCall });
      cur.tsEnd = ts;
      continue;
    }

    if (TOOL_OUTPUT_ITEM_TYPES.has(p.type)) {
      const pending = pendingTools.get(p.call_id);
      if (pending) {
        const out = truncateToolOutput(toolOutputText(p.output), maxToolOutput);
        pending.partData.state.output = out;
        pending.partData.state.time.end = ts;
        pending.toolCall.output = out;
      }
      continue;
    }
  }
  flushCur(endTs);

  return { messages, model: currentModel };
}

function assemble({ idScope, codexId, cwd, meta, parsed, options, messages, title, traceId, model, extraMeta = {} }) {
  const sessionId = `sess_${idScope}`;
  const firstTs = messages[0].ts || parsed.firstTs;
  const lastTs = messages[messages.length - 1].ts || parsed.lastTs;

  const sessionRow = {
    id: sessionId,
    project_id: projectIdFromPath(cwd),
    workspace_id: "",
    slug: sessionId,
    directory: cwd,
    path: cwd,
    title,
    version: options.zcodeVersion || "0.16.9",
    time_created: firstTs,
    time_updated: lastTs,
    task_type: "interactive",
    title_source: "first_input",
    trace_id: traceId,
  };

  const metaJson = {
    taskId: sessionId,
    traceId,
    title,
    workspacePath: cwd,
    createdAt: firstTs,
    updatedAt: lastTs,
    mode: "build",
    model,
    provider: GLM_PROVIDER,
    codexImport: true,
    codexSessionId: codexId,
    codexOriginator: meta.originator || "",
    codexCliVersion: meta.cli_version || "",
    sourceFile: parsed.filePath,
    messageCount: messages.length,
    ...extraMeta,
  };

  const taskRow = {
    workspace_key: cwd,
    workspace_path: cwd,
    workspace_identity: null,
    task_id: sessionId,
    title,
    task_status: null,
    provider: GLM_PROVIDER,
    mode: "build",
    model,
    forked_from_task_id: null,
    created_at: firstTs,
    updated_at: lastTs,
    unread_at: null,
    meta_json: JSON.stringify(metaJson),
    searchable_text: messages
      .map((m) => String(m.data.content || ""))
      .join("\n")
      .slice(0, 20000),
  };

  return {
    sessionId, codexId, cwd,
    msgIdPrefix: `msg_cx_${idScope}_`,
    archive: Boolean(extraMeta.codexArchive),
    sessionRow, taskRow, messages,
  };
}

// 一个 rollout 文件 → 一个或两个 ZCode 会话(无压缩:单个;有压缩:主 + 归档)。
export function mapRolloutFile(parsed, options = {}) {
  const maxToolOutput = options.maxToolOutput ?? 0;
  const meta = parsed.meta ?? {};
  const codexId = meta.id || uuidFromFilename(parsed.filePath);
  if (!codexId) throw new Error("无法确定 Codex 会话 id(缺 session_meta 且文件名无 uuid)");
  if (!meta.cwd) throw new Error("session_meta 缺少 cwd,无法归属项目");

  const records = parsed.records;
  const cwd = meta.cwd;
  const title = pickTitle(records) || `Codex 会话 ${codexId.slice(0, 8)}`;

  let lastCompactedIdx = -1;
  let lastCompacted = null;
  for (const [i, rec] of records.entries()) {
    if (rec.type === "compacted") {
      lastCompactedIdx = i;
      lastCompacted = rec;
    }
  }

  const results = [];

  if (lastCompactedIdx === -1) {
    const conv = buildConversation({ records, idScope: codexId, cwd, parsed, maxToolOutput });
    if (conv.messages.length === 0) throw new Error("会话无可迁移消息(全部为空)");
    results.push(
      assemble({
        idScope: codexId, codexId, cwd, meta, parsed, options,
        messages: conv.messages, title, traceId: `codex-${codexId}`, model: conv.model,
      }),
    );
    return results;
  }

  // 主会话:压缩摘要作为开场上下文 + 之后的对话(对齐 Codex resume 语义)。
  const summary = compactionSummaryText(lastCompacted.payload);
  const mainConv = buildConversation({
    records: records.slice(lastCompactedIdx + 1),
    idScope: codexId,
    cwd,
    parsed,
    maxToolOutput,
    initialUser: [
      {
        text: `[Codex 压缩摘要] 此前会话历史已压缩为以下摘要(压缩前的完整原始对话见同名归档会话):\n\n${summary}`,
        ts: lastCompacted.ts || parsed.firstTs,
      },
    ],
  });
  if (mainConv.messages.length > 0) {
    results.push(
      assemble({
        idScope: codexId, codexId, cwd, meta, parsed, options,
        messages: mainConv.messages, title, traceId: `codex-${codexId}`, model: mainConv.model,
        extraMeta: { codexCompacted: true },
      }),
    );
  }

  // 归档会话:压缩前的完整原始对话(中间压缩点同样保留原始轮次)。
  const arcConv = buildConversation({
    records: records.slice(0, lastCompactedIdx),
    idScope: `${codexId}arc`,
    cwd,
    parsed,
    maxToolOutput,
  });
  if (arcConv.messages.length > 0) {
    results.push(
      assemble({
        idScope: `${codexId}arc`, codexId, cwd, meta, parsed, options,
        messages: arcConv.messages, title: `${title}(压缩前历史)`,
        traceId: `codex-${codexId}-arc`, model: arcConv.model,
        extraMeta: { codexArchive: true, codexParentSessionId: `sess_${codexId}` },
      }),
    );
  }

  if (results.length === 0) throw new Error("会话无可迁移消息(全部为空)");
  return results;
}
