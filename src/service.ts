import { DatabaseSync } from "node:sqlite";
import {
  Analysis, analyzePosition, deriveGrundy, err, normalizeRule, validateHeaps,
} from "./grundy.js";

export class Service {
  constructor(private db: DatabaseSync) {}

  createRuleVersion(rawRules: unknown) {
    if (!Array.isArray(rawRules) || rawRules.length === 0)
      throw err("RULE_INVALID", "rules 必须是非空的规则数组（每堆一个数组）");
    const normalized = rawRules.map(normalizeRule);
    const rules = normalized.map((r) => r.moves);
    const duplicates = normalized.map((r) => r.duplicatesRemoved);
    const info = this.db
      .prepare("INSERT INTO rule_versions (rules, duplicates) VALUES (?, ?)")
      .run(JSON.stringify(rules), JSON.stringify(duplicates));
    return { ruleVersionId: Number(info.lastInsertRowid), rules, duplicatesRemoved: duplicates };
  }

  getRules(ruleVersionId: number): number[][] {
    const row = this.db.prepare("SELECT rules FROM rule_versions WHERE id = ?").get(ruleVersionId) as
      | { rules: string } | undefined;
    if (!row) throw err("RULE_VERSION_NOT_FOUND", `规则版本 ${ruleVersionId} 不存在`);
    return JSON.parse(row.rules) as number[][];
  }

  createPosition(ruleVersionId: number, rawHeaps: unknown) {
    const rules = this.getRules(ruleVersionId);
    const heaps = validateHeaps(rawHeaps);
    if (heaps.length !== rules.length)
      throw err("HEAPS_INVALID", `堆数 ${heaps.length} 与规则版本堆数 ${rules.length} 不一致`);
    const info = this.db
      .prepare("INSERT INTO positions (rule_version_id, heaps) VALUES (?, ?)")
      .run(ruleVersionId, JSON.stringify(heaps));
    return { positionId: Number(info.lastInsertRowid), ruleVersionId, heaps, turn: 0 };
  }

  getPosition(positionId: number) {
    const row = this.db.prepare("SELECT * FROM positions WHERE id = ?").get(positionId) as
      | { id: number; rule_version_id: number; heaps: string; turn: number } | undefined;
    if (!row) throw err("POSITION_NOT_FOUND", `局面 ${positionId} 不存在`);
    return {
      positionId: row.id,
      ruleVersionId: row.rule_version_id,
      heaps: JSON.parse(row.heaps) as number[],
      turn: row.turn,
    };
  }

  analyze(positionId: number | null, ruleVersionId?: number, rawHeaps?: unknown): Analysis & { analysisId: number } {
    let heaps: number[];
    let rvId: number;
    if (positionId !== null) {
      const p = this.getPosition(positionId);
      heaps = p.heaps;
      rvId = p.ruleVersionId;
    } else {
      if (ruleVersionId === undefined) throw err("BAD_REQUEST", "需提供 positionId 或 ruleVersionId+heaps");
      rvId = ruleVersionId;
      heaps = validateHeaps(rawHeaps);
    }
    const rules = this.getRules(rvId);
    if (heaps.length !== rules.length) throw err("HEAPS_INVALID", "堆数与规则版本不一致");
    const result = analyzePosition(heaps, rules);
    const info = this.db
      .prepare("INSERT INTO analyses (position_id, rule_version_id, heaps, result) VALUES (?, ?, ?, ?)")
      .run(positionId, rvId, JSON.stringify(heaps), JSON.stringify(result));
    return { analysisId: Number(info.lastInsertRowid), ...result };
  }

  grundyDerivation(ruleVersionId: number, heapIndex: number, n: number, window?: number) {
    const rules = this.getRules(ruleVersionId);
    if (!Number.isInteger(heapIndex) || heapIndex < 0 || heapIndex >= rules.length)
      throw err("HEAP_INDEX_INVALID", `堆编号 ${heapIndex} 越界`);
    if (!Number.isInteger(n) || n < 0 || n > 10000) throw err("HEAPS_INVALID", "n 须为 0..10000 的整数");
    return { heapIndex, moves: rules[heapIndex], steps: deriveGrundy(rules[heapIndex], n, window) };
  }

  applyMove(positionId: number, heapIndex: number, take: number, requestId?: string, expectedRuleVersionId?: number) {
    if (requestId) {
      const dup = this.db
        .prepare("SELECT * FROM moves WHERE position_id = ? AND request_id = ?")
        .get(positionId, requestId) as { after_heaps: string; move_no: number } | undefined;
      if (dup) {
        return { duplicated: true, heaps: JSON.parse(dup.after_heaps), moveNo: dup.move_no };
      }
    }
    const p = this.getPosition(positionId);
    if (expectedRuleVersionId !== undefined && expectedRuleVersionId !== p.ruleVersionId)
      throw err("RULE_VERSION_MISMATCH", `局面属于规则版本 ${p.ruleVersionId}，请求版本 ${expectedRuleVersionId}`);
    const rules = this.getRules(p.ruleVersionId);
    if (!Number.isInteger(heapIndex) || heapIndex < 0 || heapIndex >= p.heaps.length)
      throw err("HEAP_INDEX_INVALID", `堆编号 ${heapIndex} 越界`);
    if (!Number.isInteger(take) || take <= 0 || !rules[heapIndex].includes(take))
      throw err("MOVE_ILLEGAL", `拿取量 ${take} 不在堆 ${heapIndex} 的允许集合中`);
    if (take > p.heaps[heapIndex])
      throw err("MOVE_ILLEGAL", `拿取量 ${take} 超过堆 ${heapIndex} 当前石子数 ${p.heaps[heapIndex]}`);
    const after = p.heaps.slice();
    after[heapIndex] -= take;
    const moveNo = p.turn + 1;
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT INTO moves (position_id, rule_version_id, move_no, heap_index, take, before_heaps, after_heaps, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(positionId, p.ruleVersionId, moveNo, heapIndex, take, JSON.stringify(p.heaps), JSON.stringify(after), requestId ?? null);
      this.db.prepare("UPDATE positions SET heaps = ?, turn = ? WHERE id = ?").run(JSON.stringify(after), moveNo, positionId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { duplicated: false, heaps: after, moveNo, turn: moveNo % 2 };
  }

  verifySuggestion(positionId: number, heapIndex: number, take: number) {
    const p = this.getPosition(positionId);
    const rules = this.getRules(p.ruleVersionId);
    const legal =
      Number.isInteger(heapIndex) && heapIndex >= 0 && heapIndex < p.heaps.length &&
      Number.isInteger(take) && take > 0 && rules[heapIndex]?.includes(take) && take <= p.heaps[heapIndex];
    if (!legal) return { legal: false, winning: false, reason: "该动作不合法" };
    const analysis = analyzePosition(p.heaps, rules);
    const winning = analysis.winningMoves.some((m) => m.heapIndex === heapIndex && m.take === take);
    return {
      legal: true,
      winning,
      reason: winning
        ? "该动作合法且使对手进入必败态"
        : analysis.outcome === "P"
          ? "当前为必败态，不存在必胜着法"
          : "该动作合法但不能使组合异或归零",
    };
  }

  exportPosition(positionId: number) {
    const p = this.getPosition(positionId);
    const rules = this.getRules(p.ruleVersionId);
    const moves = this.db
      .prepare("SELECT move_no, heap_index, take, before_heaps, after_heaps, created_at FROM moves WHERE position_id = ? ORDER BY move_no")
      .all(positionId) as unknown[];
    const analyses = this.db
      .prepare("SELECT id, heaps, result, created_at FROM analyses WHERE position_id = ? ORDER BY id")
      .all(positionId) as unknown[];
    return { position: p, rules, moves, analyses };
  }

  replay(positionId: number) {
    const p = this.getPosition(positionId);
    const rules = this.getRules(p.ruleVersionId);
    const rows = this.db
      .prepare("SELECT move_no, heap_index, take, before_heaps, after_heaps FROM moves WHERE position_id = ? ORDER BY move_no")
      .all(positionId) as { move_no: number; heap_index: number; take: number; before_heaps: string; after_heaps: string }[];
    const initial = rows.length > 0 ? (JSON.parse(rows[0].before_heaps) as number[]) : p.heaps;
    let current = initial;
    const steps: { moveNo: number; heapIndex: number; take: number; heaps: number[]; ok: boolean }[] = [];
    let allOk = true;
    for (const r of rows) {
      const before = JSON.parse(r.before_heaps) as number[];
      const after = JSON.parse(r.after_heaps) as number[];
      const ok =
        JSON.stringify(before) === JSON.stringify(current) &&
        rules[r.heap_index]?.includes(r.take) &&
        r.take <= current[r.heap_index] &&
        JSON.stringify(after) === JSON.stringify(current.map((h, i) => (i === r.heap_index ? h - r.take : h)));
      if (!ok) allOk = false;
      current = after;
      steps.push({ moveNo: r.move_no, heapIndex: r.heap_index, take: r.take, heaps: after, ok });
    }
    const consistent = allOk && JSON.stringify(current) === JSON.stringify(p.heaps);
    return { initial, steps, current: p.heaps, consistent };
  }
}
