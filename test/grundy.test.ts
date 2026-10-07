import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyze, grundyTable, bruteForceWin, PileState } from "../src/grundy";
import { Service, ApiError } from "../src/service";

function tmpService(): { svc: Service; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grundy-test-"));
  return { svc: new Service(path.join(dir, "test.db")), dir };
}

test("{1,2} 的 Grundy 从 0 起按 0,1,2 循环", () => {
  const g = grundyTable([1, 2], 12);
  assert.deepEqual(g, [0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0]);
});

test("两堆 [1,2] 组合值为 3；第二堆拿 1 后 [1,1] 归零", () => {
  const mk = (a: number, b: number): PileState[] => [
    { key: "A", moves: [1, 2], stones: a },
    { key: "B", moves: [1, 2], stones: b },
  ];
  const r = analyze(mk(1, 2));
  assert.equal(r.xor, 3);
  assert.equal(r.outcome, "N");
  assert.ok(r.winningMoves.some((m) => m.pileKey === "B" && m.take === 1));
  const after = analyze(mk(1, 1));
  assert.equal(after.xor, 0);
  assert.equal(after.outcome, "P");
  assert.deepEqual(after.winningMoves, []);
});

test("空局面与零堆为必败态", () => {
  assert.equal(analyze([]).xor, 0);
  const r = analyze([{ key: "A", moves: [1, 2], stones: 0 }]);
  assert.equal(r.xor, 0);
  assert.equal(r.outcome, "P");
});

test("有石子但所有拿取量过大 -> 无合法动作，Grundy 为 0", () => {
  const r = analyze([{ key: "A", moves: [5], stones: 3 }]);
  assert.equal(r.pileGrundies[0].grundy, 0);
  assert.equal(r.outcome, "P");
});

test("空减法集合法但该堆永远不能行动", () => {
  const r = analyze([{ key: "A", moves: [], stones: 7 }]);
  assert.equal(r.pileGrundies[0].grundy, 0);
  assert.equal(r.outcome, "P");
});

test("拿取量恰好等于堆大小", () => {
  const r = analyze([{ key: "A", moves: [3], stones: 3 }]);
  assert.equal(r.pileGrundies[0].grundy, 1); // mex{g(0)}=1
  assert.ok(r.winningMoves.some((m) => m.take === 3));
});

test("不同堆可用不同减法集；多个并列必胜动作按堆+拿取量排序", () => {
  // A: {1}, stones=1 -> g=1；B: {1,3}, stones=2 -> g(2)=mex{g(1)}=mex{1}=0? 计算: g0=0,g1=mex{0}=1,g2=mex{g1}=0
  // 改用清晰场景：A{1} stones=1 (g=1), B{1,2} stones=1 (g=1) -> xor=0 不行。
  // A{1} stones=1 (g=1), B{1,2} stones=3 (g=0)? g:0,1,2,0 -> g(3)=0, xor=1。
  // 必胜动作: A 拿1 (g 1->0, xor 0) 与 B 拿1 (g 0->2? 不行)。改为直接验证排序与多解:
  const piles: PileState[] = [
    { key: "A", moves: [1], stones: 1 }, // g=1
    { key: "B", moves: [1, 2], stones: 2 }, // g=2
  ];
  const r = analyze(piles);
  assert.equal(r.xor, 3);
  // A 拿1: xor 3^1^0=2 不行；B 拿1: 3^2^1=0 ✓；B 拿2: 3^2^0=1 不行。
  assert.deepEqual(r.winningMoves, [{ pileKey: "B", take: 1, resultingXor: 0 }]);
  // 多解场景: 两堆 g 相同可取法
  const multi: PileState[] = [
    { key: "A", moves: [1, 2, 3], stones: 4 }, // g:0,1,2,3,0 -> g(4)=0
    { key: "B", moves: [1, 2, 3], stones: 1 }, // g=1
  ];
  const r2 = analyze(multi);
  assert.equal(r2.xor, 1);
  // B 拿1 -> g=0, xor 0 ✓；A: g(4-s): s=1->3, s=2->2, s=3->1 -> 1^0^x=0 -> x=1 -> s=3 ✓
  assert.deepEqual(
    r2.winningMoves,
    [
      { pileKey: "A", take: 3, resultingXor: 0 },
      { pileKey: "B", take: 1, resultingXor: 0 },
    ]
  );
});

test("小状态随机局面：Grundy 异或结论与递归枚举一致", () => {
  const moveSets = [[1, 2], [1, 3], [2], [1], [1, 2, 4]];
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let t = 0; t < 200; t++) {
    const pileCount = 1 + Math.floor(rand() * 3);
    const piles: PileState[] = [];
    for (let i = 0; i < pileCount; i++) {
      piles.push({
        key: `P${i}`,
        moves: moveSets[Math.floor(rand() * moveSets.length)],
        stones: Math.floor(rand() * 7),
      });
    }
    const r = analyze(piles);
    const brute = bruteForceWin(piles);
    assert.equal(r.outcome === "N", brute, `局面 ${JSON.stringify(piles)} 结论不一致`);
    // 每条建议合法且结果为零
    for (const m of r.winningMoves) {
      const pile = piles.find((p) => p.key === m.pileKey)!;
      assert.ok(pile.moves.includes(m.take) && m.take <= pile.stones);
      const next = piles.map((p) => (p.key === m.pileKey ? { ...p, stones: p.stones - m.take } : p));
      assert.equal(analyze(next).xor, 0);
    }
    // 必败态的所有合法动作都转为非零
    if (r.outcome === "P") {
      for (const p of piles) {
        for (const s of p.moves) {
          if (s > p.stones) continue;
          const next = piles.map((q) => (q.key === p.key ? { ...q, stones: q.stones - s } : q));
          assert.notEqual(analyze(next).xor, 0);
        }
      }
    }
  }
});

test("重复减法值被规范化并报告", () => {
  const { svc } = tmpService();
  const rs = svc.createRuleset("dup", [{ key: "A", moves: [2, 1, 2, 1] }]);
  assert.deepEqual(rs.piles[0].moves, [1, 2]);
  assert.deepEqual(rs.duplicatesRemoved, { A: [1, 2] });
  svc.close();
});

test("负数、小数拿取量被拒绝；空规则集合法", () => {
  const { svc } = tmpService();
  assert.throws(() => svc.createRuleset("bad", [{ key: "A", moves: [-1] }]), (e: any) => e.code === "INVALID_RULESET");
  assert.throws(() => svc.createRuleset("bad", [{ key: "A", moves: [1.5] }]), (e: any) => e.code === "INVALID_RULESET");
  const ok = svc.createRuleset("empty-ok", [{ key: "A", moves: [] }]);
  assert.deepEqual(ok.piles[0].moves, []);
  svc.close();
});

test("执行动作保存前后局面、轮次交替；非法/错版本/重复请求处理", () => {
  const { svc } = tmpService();
  const rs = svc.createRuleset("g", [{ key: "A", moves: [1, 2] }, { key: "B", moves: [1, 2] }]);
  const pos = svc.createPosition(rs.id, "t", { A: 1, B: 2 });

  const m1 = svc.executeMove(pos.id, "B", 1, rs.id, "req-1");
  assert.equal(m1.seq, 1);
  assert.equal(m1.player, 0);
  assert.deepEqual(m1.before, { A: 1, B: 2 });
  assert.deepEqual(m1.after, { A: 1, B: 1 });

  // 重复 requestId 不重复减石子
  const dup = svc.executeMove(pos.id, "B", 1, rs.id, "req-1");
  assert.equal(dup.duplicate, true);
  assert.equal(dup.moveId, m1.moveId);
  assert.deepEqual(svc.currentStones(pos.id).stones, { A: 1, B: 1 });

  const m2 = svc.executeMove(pos.id, "A", 1);
  assert.equal(m2.player, 1);

  // 非法拿取
  assert.throws(() => svc.executeMove(pos.id, "A", 2), (e: any) => e.code === "INVALID_MOVE");
  // 拿取量超过石子
  assert.throws(() => svc.executeMove(pos.id, "B", 2), (e: any) => e.code === "INVALID_MOVE");
  // 错版本
  assert.throws(() => svc.executeMove(pos.id, "B", 1, 999), (e: any) => e.code === "VERSION_MISMATCH");
  svc.close();
});

test("重启后可回放每一步并核对当前石子数", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grundy-test-"));
  const dbPath = path.join(dir, "test.db");
  let posId = 0;
  {
    const svc = new Service(dbPath);
    const rs = svc.createRuleset("g", [{ key: "A", moves: [1, 2] }]);
    const pos = svc.createPosition(rs.id, "t", { A: 5 });
    posId = pos.id;
    svc.executeMove(pos.id, "A", 2);
    svc.executeMove(pos.id, "A", 1);
    svc.close();
  }
  {
    const svc = new Service(dbPath); // 模拟重启
    const replay = svc.replay(posId);
    assert.deepEqual(replay.initial, { A: 5 });
    assert.equal(replay.steps.length, 2);
    assert.deepEqual(replay.steps[0].after, { A: 3 });
    assert.deepEqual(replay.steps[1].after, { A: 2 });
    assert.deepEqual(replay.current, { A: 2 });
    assert.deepEqual(svc.currentStones(posId).stones, { A: 2 });
    svc.close();
  }
});

test("修改规则创建新局面，旧历史不套用新减法集", () => {
  const { svc } = tmpService();
  const rs1 = svc.createRuleset("v1", [{ key: "A", moves: [1] }]);
  const rs2 = svc.createRuleset("v2", [{ key: "A", moves: [1, 2] }]);
  const pos = svc.createPosition(rs1.id, "old", { A: 3 });
  svc.executeMove(pos.id, "A", 1);
  // 旧局面仍按 v1 规则分析：A=2, g(2)=mex{g1}=mex{1}=0
  const a = svc.analyzePosition(pos.id);
  assert.equal(a.rulesetId, rs1.id);
  assert.equal(a.pileGrundies[0].grundy, 0);
  // 用 v2 分析同一大小则 g(2)=2
  const d = svc.grundyDerivation(rs2.id, "A", 2);
  assert.equal(d.grundy, 2);
  svc.close();
});

test("Grundy 推导给出可达集合与 mex，窗口截断仅影响展示", () => {
  const { svc } = tmpService();
  const rs = svc.createRuleset("g", [{ key: "A", moves: [1, 2] }]);
  const d = svc.grundyDerivation(rs.id, "A", 100, 5);
  assert.equal(d.grundy, 1); // 100 % 3 == 1
  assert.deepEqual(d.reachable, [{ take: 1, grundy: 0 }, { take: 2, grundy: 2 }]);
  assert.equal(d.mex, 1);
  assert.equal(d.window.length, 6);
  assert.equal(d.windowFrom, 95);
  svc.close();
});

test("核验外部建议", () => {
  const { svc } = tmpService();
  const rs = svc.createRuleset("g", [{ key: "A", moves: [1, 2] }, { key: "B", moves: [1, 2] }]);
  const pos = svc.createPosition(rs.id, "t", { A: 1, B: 2 });
  const ok = svc.verifySuggestion(pos.id, [{ pileKey: "B", take: 1 }]);
  assert.equal(ok.allAccepted, true);
  const bad = svc.verifySuggestion(pos.id, [{ pileKey: "A", take: 1 }]);
  assert.equal(bad.allAccepted, false);
  assert.equal(bad.checks[0].legal, true);
  assert.equal(bad.checks[0].leadsToZeroXor, false);
  svc.close();
});

test("超限被拒绝", () => {
  const { svc } = tmpService();
  const rs = svc.createRuleset("g", [{ key: "A", moves: [1] }]);
  assert.throws(() => svc.createPosition(rs.id, "x", { A: 10001 }), (e: any) => e.code === "LIMIT_EXCEEDED");
  svc.close();
});

test("导出包含规则、回放与分析历史", () => {
  const { svc } = tmpService();
  const rs = svc.createRuleset("g", [{ key: "A", moves: [1, 2] }]);
  const pos = svc.createPosition(rs.id, "t", { A: 3 });
  svc.analyzePosition(pos.id);
  svc.executeMove(pos.id, "A", 2, rs.id, "r1");
  svc.analyzePosition(pos.id);
  const exp = svc.exportPosition(pos.id);
  assert.equal(exp.ruleset.id, rs.id);
  assert.equal(exp.position.steps.length, 1);
  assert.equal(exp.analyses.length, 2);
  svc.close();
});
