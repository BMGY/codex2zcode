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
    records.push({ ts: Number.isFinite(ts) ? ts : 0, type: rec.type, payload: rec.payload ?? {} });
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
