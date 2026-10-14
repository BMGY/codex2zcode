// 解析 Codex rollout JSONL(逐行 JSON,保留原始顺序供 mapper 交错遍历)。
import { readFileSync } from "node:fs";
import { basename } from "node:path";

export function uuidFromFilename(filePath) {
  const m = basename(filePath).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  );
  return m ? m[1] : null;
}

export function parseRollout(filePath) {
  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split("\n");
  const records = [];
  let parseErrors = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      parseErrors++;
      continue;
    }
    if (!rec || typeof rec.type !== "string") continue;
    const ts = Date.parse(rec.timestamp);
    records.push({
      ordinal: typeof rec.ordinal === "number" ? rec.ordinal : null,
      ts: Number.isFinite(ts) ? ts : 0,
      type: rec.type,
      payload: rec.payload ?? {},
    });
  }

  const meta = records.find((r) => r.type === "session_meta")?.payload ?? null;
  const timestamps = records.map((r) => r.ts).filter((t) => t > 0);

  return {
    filePath,
    meta,
    records,
    parseErrors,
    firstTs: timestamps.length ? Math.min(...timestamps) : 0,
    lastTs: timestamps.length ? Math.max(...timestamps) : 0,
  };
}

// 合并同一会话的多份 rollout(resume 会产生新文件并回放尾部记录;ordinal 会话内全局单调,
// 按 (ordinal, type) 去重后排序即为完整历史)。session_meta 每份文件各带一条,仅保留最早文件的。
export function mergeRollouts(parsedList) {
  const byKey = new Map();
  let meta = null;
  let filePath = null;
  let firstTs = Infinity;
  let lastTs = 0;
  for (const parsed of parsedList) {
    if (!filePath) filePath = parsed.filePath;
    if (!meta && parsed.meta) meta = parsed.meta;
    if (parsed.firstTs) firstTs = Math.min(firstTs, parsed.firstTs);
    if (parsed.lastTs) lastTs = Math.max(lastTs, parsed.lastTs);
    for (const rec of parsed.records) {
      if (rec.type === "session_meta") continue;
      const key =
        rec.ordinal != null
          ? `${rec.ordinal}|${rec.type}`
          : `${rec.ts}|${rec.type}|${JSON.stringify(rec.payload ?? {}).length}`;
      if (!byKey.has(key)) byKey.set(key, rec);
    }
  }
  const records = [...byKey.values()].sort((a, b) => {
    const oa = a.ordinal != null ? a.ordinal : 1e13 + a.ts / 1e6;
    const ob = b.ordinal != null ? b.ordinal : 1e13 + b.ts / 1e6;
    return oa - ob;
  });
  return {
    filePath,
    meta,
    records,
    parseErrors: 0,
    firstTs: Number.isFinite(firstTs) ? firstTs : 0,
    lastTs,
  };
}
