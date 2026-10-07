export const MAX_HEAP_SIZE = 10000;
export const MAX_HEAPS = 100;
export const MAX_TOTAL_STATES = 1_000_000;

export function err(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

export interface NormalizedRule {
  moves: number[];
  duplicatesRemoved: number[];
}

export function normalizeRule(raw: unknown): NormalizedRule {
  if (!Array.isArray(raw)) throw err("RULE_INVALID", "每堆规则必须是正整数数组");
  const seen = new Set<number>();
  const dups: number[] = [];
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0)
      throw err("RULE_INVALID", `非法拿取量 ${String(v)}：仅允许正整数`);
    if (seen.has(v)) dups.push(v);
    else seen.add(v);
  }
  return { moves: [...seen].sort((a, b) => a - b), duplicatesRemoved: dups };
}

export function validateHeaps(raw: unknown): number[] {
  if (!Array.isArray(raw)) throw err("HEAPS_INVALID", "heaps 必须是非负整数数组");
  if (raw.length > MAX_HEAPS) throw err("LIMIT_EXCEEDED", `堆数超过上限 ${MAX_HEAPS}`);
  let states = 0;
  for (const h of raw) {
    if (typeof h !== "number" || !Number.isInteger(h) || h < 0)
      throw err("HEAPS_INVALID", `非法石子数 ${String(h)}：须为非负整数`);
    if (h > MAX_HEAP_SIZE) throw err("LIMIT_EXCEEDED", `单堆石子数超过上限 ${MAX_HEAP_SIZE}`);
    states += h + 1;
  }
  if (states > MAX_TOTAL_STATES) throw err("LIMIT_EXCEEDED", `总 DP 状态数超过上限 ${MAX_TOTAL_STATES}`);
  return raw as number[];
}

/** 单堆 Grundy 序列 g(0..n)：g(0)=0，g(n)=mex{ g(n-s) : s in moves, s<=n }。 */
export function grundySequence(moves: number[], n: number): number[] {
  const g = new Array<number>(n + 1);
  g[0] = 0;
  for (let i = 1; i <= n; i++) {
    const seen = new Set<number>();
    for (const s of moves) {
      if (s > i) break;
      seen.add(g[i - s]);
    }
    let mex = 0;
    while (seen.has(mex)) mex++;
    g[i] = mex;
  }
  return g;
}

export interface DerivationStep {
  n: number;
  reachable: { take: number; value: number }[];
  reachableSet: number[];
  mex: number;
  truncated: boolean;
}

export function deriveGrundy(moves: number[], n: number, window = 20): DerivationStep[] {
  const g = grundySequence(moves, n);
  const steps: DerivationStep[] = [];
  const from = Math.max(0, n - window + 1);
  for (let i = from; i <= n; i++) {
    const reachable: { take: number; value: number }[] = [];
    const set = new Set<number>();
    for (const s of moves) {
      if (s > i) break;
      reachable.push({ take: s, value: g[i - s] });
      set.add(g[i - s]);
    }
    steps.push({
      n: i,
      reachable,
      reachableSet: [...set].sort((a, b) => a - b),
      mex: g[i],
      truncated: from > 0 && i === from,
    });
  }
  return steps;
}

export interface WinningMove {
  heapIndex: number;
  take: number;
  resultingHeaps: number[];
  resultingXor: number;
}

export interface Analysis {
  heapGrundies: number[];
  totalXor: number;
  outcome: "N" | "P";
  winningMoves: WinningMove[];
  explanation: string;
}

export function analyzePosition(heaps: number[], rules: number[][]): Analysis {
  const heapGrundies = heaps.map((h, i) => grundySequence(rules[i], h)[h]);
  let totalXor = 0;
  for (const v of heapGrundies) totalXor ^= v;
  const winningMoves: WinningMove[] = [];
  for (let i = 0; i < heaps.length; i++) {
    const g = grundySequence(rules[i], heaps[i]);
    for (const s of rules[i]) {
      if (s > heaps[i]) break;
      const after = heaps.slice();
      after[i] -= s;
      const x = totalXor ^ heapGrundies[i] ^ g[after[i]];
      if (x === 0) winningMoves.push({ heapIndex: i, take: s, resultingHeaps: after, resultingXor: 0 });
    }
  }
  winningMoves.sort((a, b) => a.heapIndex - b.heapIndex || a.take - b.take);
  const outcome = totalXor === 0 ? "P" : "N";
  const explanation =
    outcome === "P"
      ? "组合 Grundy 异或为 0，是必败态（P 态）：双方最优行动下无任何保证获胜的着法，建议列表为空。"
      : `组合 Grundy 异或为 ${totalXor}，是必胜态（N 态）：下列着法均使对手进入异或为 0 的必败态。`;
  return { heapGrundies, totalXor, outcome, winningMoves, explanation };
}
