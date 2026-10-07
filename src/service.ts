import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  analyze,
  deriveGrundy,
  PileRule,
  PileState,
  AnalysisResult,
  GrundyDerivation,
} from "./grundy";

export const LIMITS = {
  maxPiles: 64,
  maxStonesPerPile: 10000,
  maxTotalDpStates: 200000,
};

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export interface PileInput {
  key: string;
  moves: number[];
  stones?: number;
}

function normalizeMoves(raw: unknown): { moves: number[]; duplicatesRemoved: number[] } {
  if (!Array.isArray(raw)) throw new ApiError("INVALID_RULESET", "moves 必须是数组");
  const seen = new Set<number>();
  const dups = new Set<number>();
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isInteger(v)) {
      throw new ApiError("INVALID_RULESET", `拿取量必须是整数，收到: ${v}`);
    }
    if (v <= 0) {
      throw new ApiError("INVALID_RULESET", `拿取量必须是正整数，收到: ${v}`);
    }
    if (seen.has(v)) dups.add(v);
    seen.add(v);
  }
  return { moves: [...seen].sort((a, b) => a - b), duplicatesRemoved: [...dups].sort((a, b) => a - b) };
}

function normalizeStones(raw: unknown, pileKey: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new ApiError("INVALID_POSITION", `堆 ${pileKey} 的石子数必须是非负整数，收到: ${raw}`);
  }
  if (raw > LIMITS.maxStonesPerPile) {
    throw new ApiError("LIMIT_EXCEEDED", `堆 ${pileKey} 石子数超过上限 ${LIMITS.maxStonesPerPile}`);
  }
  return raw;
}

export class Service {
  private db: DatabaseSync;

  constructor(public readonly dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS rulesets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        definition TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ruleset_id INTEGER NOT NULL REFERENCES rulesets(id),
        label TEXT NOT NULL DEFAULT '',
        initial_stones TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS moves (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id INTEGER NOT NULL REFERENCES positions(id),
        ruleset_id INTEGER NOT NULL REFERENCES rulesets(id),
        seq INTEGER NOT NULL,
        player INTEGER NOT NULL,
        pile_key TEXT NOT NULL,
        take INTEGER NOT NULL,
        before_stones TEXT NOT NULL,
        after_stones TEXT NOT NULL,
        request_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (position_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS analyses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id INTEGER NOT NULL REFERENCES positions(id),
        ruleset_id INTEGER NOT NULL REFERENCES rulesets(id),
        move_seq INTEGER NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  private now(): string {
    return new Date().toISOString();
  }

  createRuleset(name: string, piles: PileInput[]) {
    if (!name || typeof name !== "string") throw new ApiError("INVALID_RULESET", "name 必填");
    if (!Array.isArray(piles) || piles.length === 0) {
      throw new ApiError("INVALID_RULESET", "piles 不能为空");
    }
    if (piles.length > LIMITS.maxPiles) {
      throw new ApiError("LIMIT_EXCEEDED", `堆数超过上限 ${LIMITS.maxPiles}`);
    }
    const keys = new Set<string>();
    const normalized: PileRule[] = [];
    const duplicateReport: Record<string, number[]> = {};
    for (const p of piles) {
      if (!p || typeof p.key !== "string" || p.key.length === 0) {
        throw new ApiError("INVALID_RULESET", "每堆需要非空字符串 key");
      }
      if (keys.has(p.key)) throw new ApiError("INVALID_RULESET", `堆编号重复: ${p.key}`);
      keys.add(p.key);
      const { moves, duplicatesRemoved } = normalizeMoves(p.moves);
      if (duplicatesRemoved.length > 0) duplicateReport[p.key] = duplicatesRemoved;
      normalized.push({ key: p.key, moves });
    }
    const stmt = this.db.prepare("INSERT INTO rulesets (name, definition) VALUES (?, ?)");
    const r = stmt.run(name, JSON.stringify(normalized));
    return {
      id: Number(r.lastInsertRowid),
      name,
      piles: normalized,
      duplicatesRemoved: duplicateReport,
    };
  }

  getRuleset(id: number): { id: number; name: string; piles: PileRule[] } {
    const row = this.db.prepare("SELECT * FROM rulesets WHERE id = ?").get(id) as any;
    if (!row) throw new ApiError("NOT_FOUND", `规则版本 ${id} 不存在`, 404);
    return { id: row.id, name: row.name, piles: JSON.parse(row.definition) };
  }

  createPosition(rulesetId: number, label: string, stones: Record<string, number>) {
    const rs = this.getRuleset(rulesetId);
    const initial: Record<string, number> = {};
    let total = 0;
    for (const pile of rs.piles) {
      const n = normalizeStones(stones?.[pile.key] ?? 0, pile.key);
      initial[pile.key] = n;
      total += n;
    }
    if (total > LIMITS.maxTotalDpStates) {
      throw new ApiError("LIMIT_EXCEEDED", `总 DP 状态数超过上限 ${LIMITS.maxTotalDpStates}`);
    }
    const r = this.db
      .prepare("INSERT INTO positions (ruleset_id, label, initial_stones) VALUES (?, ?, ?)")
      .run(rulesetId, label ?? "", JSON.stringify(initial));
    return { id: Number(r.lastInsertRowid), rulesetId, label: label ?? "", initialStones: initial };
  }

  private getPositionRow(id: number): any {
    const row = this.db.prepare("SELECT * FROM positions WHERE id = ?").get(id);
    if (!row) throw new ApiError("NOT_FOUND", `局面 ${id} 不存在`, 404);
    return row;
  }

  // 当前石子数 = 初态依次应用动作链（重启后可回放核对）。
  currentStones(positionId: number): { stones: Record<string, number>; moveCount: number; rulesetId: number } {
    const pos = this.getPositionRow(positionId);
    const stones: Record<string, number> = JSON.parse(pos.initial_stones);
    const moves = this.db
      .prepare("SELECT * FROM moves WHERE position_id = ? ORDER BY seq ASC")
      .all(positionId) as any[];
    for (const m of moves) {
      stones[m.pile_key] = JSON.parse(m.after_stones)[m.pile_key];
    }
    return { stones, moveCount: moves.length, rulesetId: pos.ruleset_id };
  }

  private pileStates(positionId: number): PileState[] {
    const { stones, rulesetId } = this.currentStones(positionId);
    const rs = this.getRuleset(rulesetId);
    return rs.piles.map((p) => ({ ...p, stones: stones[p.key] ?? 0 }));
  }

  analyzePosition(positionId: number): AnalysisResult & { positionId: number; rulesetId: number; moveSeq: number } {
    const piles = this.pileStates(positionId);
    const { moveCount, rulesetId } = this.currentStones(positionId);
    const result = analyze(piles);
    this.db
      .prepare("INSERT INTO analyses (position_id, ruleset_id, move_seq, result) VALUES (?, ?, ?, ?)")
      .run(positionId, rulesetId, moveCount, JSON.stringify(result));
    return { positionId, rulesetId, moveSeq: moveCount, ...result };
  }

  grundyDerivation(rulesetId: number, pileKey: string, n: number, windowSize?: number): GrundyDerivation {
    const rs = this.getRuleset(rulesetId);
    const pile = rs.piles.find((p) => p.key === pileKey);
    if (!pile) throw new ApiError("NOT_FOUND", `规则版本 ${rulesetId} 中没有堆 ${pileKey}`, 404);
    const size = normalizeStones(n, pileKey);
    return deriveGrundy(pileKey, pile.moves, size, windowSize);
  }

  executeMove(
    positionId: number,
    pileKey: string,
    take: number,
    expectedRulesetId?: number,
    requestId?: string
  ) {
    const pos = this.getPositionRow(positionId);
    if (expectedRulesetId !== undefined && expectedRulesetId !== pos.ruleset_id) {
      throw new ApiError(
        "VERSION_MISMATCH",
        `局面 ${positionId} 使用规则版本 ${pos.ruleset_id}，与期望版本 ${expectedRulesetId} 不一致`,
        409
      );
    }
    if (requestId) {
      const existing = this.db
        .prepare("SELECT * FROM moves WHERE position_id = ? AND request_id = ?")
        .get(positionId, requestId) as any;
      if (existing) {
        return { ...this.moveView(existing), duplicate: true };
      }
    }
    const rs = this.getRuleset(pos.ruleset_id);
    const pile = rs.piles.find((p) => p.key === pileKey);
    if (!pile) throw new ApiError("INVALID_MOVE", `堆 ${pileKey} 不存在`);
    if (!Number.isInteger(take) || take <= 0) {
      throw new ApiError("INVALID_MOVE", `拿取量必须是正整数，收到: ${take}`);
    }
    if (!pile.moves.includes(take)) {
      throw new ApiError("INVALID_MOVE", `堆 ${pileKey} 不允许拿取 ${take}（允许: [${pile.moves}]）`);
    }
    const { stones, moveCount } = this.currentStones(positionId);
    if (take > stones[pileKey]) {
      throw new ApiError("INVALID_MOVE", `堆 ${pileKey} 只有 ${stones[pileKey]} 颗石子，无法拿取 ${take}`);
    }
    const before = { ...stones };
    const after = { ...stones, [pileKey]: stones[pileKey] - take };
    const seq = moveCount + 1;
    const player = (seq - 1) % 2; // 轮次交替：0 为先手，1 为后手
    try {
      const r = this.db
        .prepare(
          `INSERT INTO moves (position_id, ruleset_id, seq, player, pile_key, take, before_stones, after_stones, request_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(positionId, pos.ruleset_id, seq, player, pileKey, take, JSON.stringify(before), JSON.stringify(after), requestId ?? null);
      const row = this.db.prepare("SELECT * FROM moves WHERE id = ?").get(Number(r.lastInsertRowid)) as any;
      return { ...this.moveView(row), duplicate: false };
    } catch (e: any) {
      if (requestId && String(e.message).includes("UNIQUE")) {
        const existing = this.db
          .prepare("SELECT * FROM moves WHERE position_id = ? AND request_id = ?")
          .get(positionId, requestId) as any;
        return { ...this.moveView(existing), duplicate: true };
      }
      throw e;
    }
  }

  private moveView(m: any) {
    return {
      moveId: m.id,
      positionId: m.position_id,
      rulesetId: m.ruleset_id,
      seq: m.seq,
      player: m.player,
      pileKey: m.pile_key,
      take: m.take,
      before: JSON.parse(m.before_stones),
      after: JSON.parse(m.after_stones),
      requestId: m.request_id,
    };
  }

  verifySuggestion(positionId: number, moves: { pileKey: string; take: number }[]) {
    const piles = this.pileStates(positionId);
    const result = analyze(piles);
    const suggested = new Set(result.winningMoves.map((m) => `${m.pileKey}:${m.take}`));
    const checks = moves.map((m) => {
      const pile = piles.find((p) => p.key === m.pileKey);
      const legal =
        !!pile && Number.isInteger(m.take) && m.take > 0 && pile.moves.includes(m.take) && m.take <= pile.stones;
      const isWinning = suggested.has(`${m.pileKey}:${m.take}`);
      return { pileKey: m.pileKey, take: m.take, legal, leadsToZeroXor: isWinning, accepted: legal && isWinning };
    });
    return {
      positionId,
      currentXor: result.xor,
      outcome: result.outcome,
      checks,
      allAccepted: checks.length > 0 && checks.every((c) => c.accepted),
    };
  }

  replay(positionId: number) {
    const pos = this.getPositionRow(positionId);
    const moves = this.db
      .prepare("SELECT * FROM moves WHERE position_id = ? ORDER BY seq ASC")
      .all(positionId) as any[];
    const steps = moves.map((m) => this.moveView(m));
    const current = steps.length > 0 ? steps[steps.length - 1].after : JSON.parse(pos.initial_stones);
    return {
      positionId,
      rulesetId: pos.ruleset_id,
      initial: JSON.parse(pos.initial_stones),
      steps,
      current,
    };
  }

  exportPosition(positionId: number) {
    const replay = this.replay(positionId);
    const rs = this.getRuleset(replay.rulesetId);
    const analyses = this.db
      .prepare("SELECT * FROM analyses WHERE position_id = ? ORDER BY id ASC")
      .all(positionId) as any[];
    return {
      exportedAt: this.now(),
      ruleset: rs,
      position: replay,
      analyses: analyses.map((a) => ({ moveSeq: a.move_seq, result: JSON.parse(a.result) })),
    };
  }
}
