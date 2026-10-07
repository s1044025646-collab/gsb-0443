// 有限减法取石游戏的 Sprague–Grundy 核心计算。
// g(0) = 0；g(n) = mex{ g(n-s) : s ∈ S, s <= n }。
// 一堆有石子但所有允许拿取量都大于 n 时无合法动作，g(n) = 0。

export interface PileRule {
  key: string;
  moves: number[]; // 已规范化：正整数、去重、升序；可为空集
}

export interface PileState extends PileRule {
  stones: number;
}

export function mex(values: Iterable<number>): number {
  const seen = new Set(values);
  let m = 0;
  while (seen.has(m)) m++;
  return m;
}

// 计算 g(0..n)，返回长度 n+1 的数组。
export function grundyTable(moves: number[], n: number): number[] {
  const g = new Array<number>(n + 1);
  g[0] = 0;
  for (let i = 1; i <= n; i++) {
    const reachable: number[] = [];
    for (const s of moves) {
      if (s > i) break; // moves 已升序
      reachable.push(g[i - s]);
    }
    g[i] = mex(reachable);
  }
  return g;
}

export function grundy(moves: number[], n: number): number {
  return grundyTable(moves, n)[n];
}

export interface MoveOption {
  pileKey: string;
  take: number;
  resultingXor: number;
}

export interface AnalysisResult {
  xor: number;
  outcome: "N" | "P"; // N=必胜态, P=必败态
  pileGrundies: { pileKey: string; stones: number; grundy: number }[];
  winningMoves: MoveOption[]; // 仅含使组合值归零的动作，按堆编号+拿取量排序
  explanation: string;
}

export function analyze(piles: PileState[]): AnalysisResult {
  const pileGrundies = piles.map((p) => ({
    pileKey: p.key,
    stones: p.stones,
    grundy: grundy(p.moves, p.stones),
  }));
  const xor = pileGrundies.reduce((acc, p) => acc ^ p.grundy, 0);

  const winningMoves: MoveOption[] = [];
  if (xor !== 0) {
    for (const p of piles) {
      const g = grundy(p.moves, p.stones);
      const table = grundyTable(p.moves, p.stones);
      for (const s of p.moves) {
        if (s > p.stones) break;
        const resulting = xor ^ g ^ table[p.stones - s];
        if (resulting === 0) {
          winningMoves.push({ pileKey: p.key, take: s, resultingXor: 0 });
        }
      }
    }
    winningMoves.sort((a, b) =>
      a.pileKey === b.pileKey ? a.take - b.take : a.pileKey < b.pileKey ? -1 : 1
    );
  }

  const explanation =
    xor === 0
      ? "各堆 Grundy 值异或为 0，当前为必败态（P 态）。在双方最优行动前提下，任何合法动作都会使对手进入必胜态，因此不提供必胜建议。"
      : `各堆 Grundy 值异或为 ${xor}，当前为必胜态（N 态）。列出全部可使异或归零的动作；假设双方之后均按规则最优行动。`;

  return { xor, outcome: xor === 0 ? "P" : "N", pileGrundies, winningMoves, explanation };
}

export interface GrundyDerivation {
  pileKey: string;
  n: number;
  grundy: number;
  reachable: { take: number; grundy: number }[]; // 完整可达集合（真实计算依据）
  mex: number;
  window: number[]; // 展示用窗口 g(from..n)，截断仅影响展示
  windowFrom: number;
}

export function deriveGrundy(
  pileKey: string,
  moves: number[],
  n: number,
  windowSize = 20
): GrundyDerivation {
  const table = grundyTable(moves, n);
  const reachable = moves.filter((s) => s <= n).map((s) => ({ take: s, grundy: table[n - s] }));
  const from = Math.max(0, n - windowSize);
  return {
    pileKey,
    n,
    grundy: table[n],
    reachable,
    mex: mex(reachable.map((r) => r.grundy)),
    window: table.slice(from, n + 1),
    windowFrom: from,
  };
}

// 独立递归枚举完整组合局面的胜负（仅用于小状态测试交叉验证）。
export function bruteForceWin(piles: PileState[], memo = new Map<string, boolean>()): boolean {
  const key = piles.map((p) => p.stones).join(",");
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let win = false;
  for (let i = 0; i < piles.length && !win; i++) {
    const p = piles[i];
    for (const s of p.moves) {
      if (s > p.stones) break;
      const next = piles.map((q, j) => (j === i ? { ...q, stones: q.stones - s } : q));
      if (!bruteForceWin(next, memo)) {
        win = true;
        break;
      }
    }
  }
  memo.set(key, win);
  return win;
}
