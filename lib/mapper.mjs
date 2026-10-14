// Codex rollout 记录 → ZCode session/message/part 行的映射。
// 契约依据:ZCode 官方 restore-legacy-sessions 插件的写入实现(provider 必须 glm、
// user 消息带空 model:{}、tool 时间放 state.time、详情页正文来自 part 表)。
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

export function mapSession(parsed, options = {}) {
  const meta = parsed.meta ?? {};
  const codexId = meta.id || uuidFromFilename(parsed.filePath);
  if (!codexId) throw new Error("无法确定 Codex 会话 id(缺 session_meta 且文件名无 uuid)");
  if (!meta.cwd) throw new Error("session_meta 缺少 cwd,无法归属项目");

  const sessionId = `sess_${codexId}`;
  const cwd = meta.cwd;
  const root = cwd;
  const mkMsgId = (i) => `msg_cx_${codexId}_${String(i).padStart(5, "0")}`;
  const mkPartId = (mi, pi) => `part_cx_${codexId}_${String(mi).padStart(5, "0")}_${String(pi).padStart(4, "0")}`;

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

  for (const rec of parsed.records) {
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
      // Codex 压缩语义:此前历史被摘要替代,discard 旧消息、以摘要作为新一轮输入。
      flushCur(ts);
      messages.length = 0;
      seq = 0;
      lastUserMsgId = "";
      lastTokens = null;
      pendingTools.clear();
      const summary =
        typeof p.message === "string"
          ? p.message
          : textFromContent(p.message?.content) || JSON.stringify(p.message ?? {});
      pushUserMessage(`[Codex 压缩摘要] 此前会话历史已压缩为以下摘要:\n\n${summary}`, ts, { compaction: true });
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
      const callID = p.call_id || `call_cx_${codexId}_${seq}_${cur.parts.length}`;
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
        const out = toolOutputText(p.output);
        pending.partData.state.output = out;
        pending.partData.state.time.end = ts;
        pending.toolCall.output = out;
      }
      continue;
    }
  }
  flushCur(parsed.lastTs);

  if (messages.length === 0) throw new Error("会话无可迁移消息(全部为空)");

  // 标题:第一条有实际内容的用户消息(跳过注入上下文/权限评估/压缩摘要),
  // 压缩开场时从摘要抽 "User's current goal",最后退化为首条 assistant 文本。
  let titleText = "";
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (m.compaction) {
      const goal = m.data.content.match(/User['’']s current goal:?\s*([\s\S]{1,200})/i);
      if (goal) {
        titleText = goal[1].replace(/\s+/g, " ").trim().slice(0, 80);
        break;
      }
      continue;
    }
    const cleaned = extractUserText(m.data.content);
    if (!isNoiseUserText(cleaned)) {
      titleText = cleaned.slice(0, 80);
      break;
    }
  }
  if (!titleText) {
    const firstAssistant = messages.find((m) => m.role === "assistant");
    if (firstAssistant) titleText = cleanTitle(firstAssistant.data.content).slice(0, 80);
  }
  const title = titleText || `Codex 会话 ${codexId.slice(0, 8)}`;

  const firstTs = messages[0].ts || parsed.firstTs;
  const lastTs = messages[messages.length - 1].ts || parsed.lastTs;
  const traceId = `codex-${codexId}`;
  const lastModel = currentModel;

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
    model: lastModel,
    provider: GLM_PROVIDER,
    codexImport: true,
    codexSessionId: codexId,
    codexOriginator: meta.originator || "",
    codexCliVersion: meta.cli_version || "",
    sourceFile: parsed.filePath,
    messageCount: messages.length,
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
    model: lastModel,
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

  return { sessionId, codexId, cwd, sessionRow, taskRow, messages };
}
