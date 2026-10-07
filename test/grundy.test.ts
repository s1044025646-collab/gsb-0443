import test from "node:test";
import assert from "node:assert/strict";
import { grundySequence, analyzePosition, normalizeRule, validateHeaps } from "../src/grundy.js";

test("{1,2} 规则 Grundy 按 0,1,2 循环", () => {
  const g = grundySequence([1, 2], 9);
  assert.deepEqual(g, [0, 1, 2, 0, 1, 2, 0, 1, 2, 0]);
});

test("g(0)=0；有石子但所有拿取量过大时 g=0", () => {
  assert.equal(grundySequence([5], 3)[3], 0);
  assert.equal(grundySequence([], 4)[4], 0);
});

test("拿取量恰好等于堆大小", () => {
  const g = grundySequence([3], 3);
  assert.equal(g[3], 1); // mex{g(0)}=mex{0}=1
});

test("两堆 [1,2] 规则 {1,2} 组合值为 3，第二堆拿一归零", () => {
  const a = analyzePosition([1, 2], [[1, 2], [1, 2]]);
  assert.equal(a.totalXor, 3);
  assert.equal(a.outcome, "N");
  assert.deepEqual(a.winningMoves.map((m) => [m.heapIndex, m.take]), [[1, 1]]);
  assert.deepEqual(a.winningMoves[0].resultingHeaps, [1, 1]);
});

test("空局面与零堆为必败态且无建议", () => {
  for (const heaps of [[], [0], [0, 0]]) {
    const rules = heaps.map(() => [1, 2]);
    const a = analyzePosition(heaps, rules);
    assert.equal(a.totalXor, 0);
    assert.equal(a.outcome, "P");
    assert.deepEqual(a.winningMoves, []);
  }
});

test("正大小但无合法动作（空规则集）为必败态", () => {
  const a = analyzePosition([5, 3], [[], []]);
  assert.equal(a.outcome, "P");
  assert.deepEqual(a.winningMoves, []);
});

test("不同堆不同减法集合", () => {
  const a = analyzePosition([3, 3], [[1], [1, 2, 3]]);
  assert.equal(a.heapGrundies[0], 1); // {1}: g(3)=1
  assert.equal(a.heapGrundies[1], 3); // {1,2,3}: g(3)=mex{g2,g1,g0}=mex{2,1,0}=3
});

test("多个并列必胜动作按堆编号与拿取量排序", () => {
  // 规则 {1,2}，堆 [2,3,3]：g = 2,0,0，xor=2，存在多条并列必胜着法
  const rules = [[1, 2], [1, 2], [1, 2]];
  const a = analyzePosition([2, 3, 3], rules);
  assert.equal(a.totalXor, 2);
  assert.ok(a.winningMoves.length >= 2);
  const keys = a.winningMoves.map((m) => m.heapIndex * 100 + m.take);
  assert.deepEqual(keys, [...keys].sort((x, y) => x - y));
  for (const m of a.winningMoves) assert.equal(m.resultingXor, 0);
});

test("规则规范化：重复值去重并报告，非法值报错", () => {
  const r = normalizeRule([2, 1, 2, 3, 1]);
  assert.deepEqual(r.moves, [1, 2, 3]);
  assert.deepEqual(r.duplicatesRemoved, [2, 1]);
  assert.throws(() => normalizeRule([1, -2]), /正整数/);
  assert.throws(() => normalizeRule([1.5]), /正整数/);
  assert.deepEqual(normalizeRule([]).moves, []);
});

test("heaps 校验", () => {
  assert.deepEqual(validateHeaps([0, 5]), [0, 5]);
  assert.throws(() => validateHeaps([-1]), /非负整数/);
  assert.throws(() => validateHeaps([1.5]), /非负整数/);
});

test("小状态独立递归枚举与 Grundy 异或一致", () => {
  const rules = [[1, 2], [1, 3], [2]];
  const win = (heaps: number[]): boolean => {
    for (let i = 0; i < heaps.length; i++)
      for (const s of rules[i])
        if (s <= heaps[i]) {
          const next = heaps.slice();
          next[i] -= s;
          if (!win(next)) return true;
        }
    return false;
  };
  for (let a = 0; a <= 4; a++)
    for (let b = 0; b <= 4; b++)
      for (let c = 0; c <= 3; c++) {
        const heaps = [a, b, c];
        const res = analyzePosition(heaps, rules);
        assert.equal(res.outcome === "N", win(heaps), `heaps=${heaps}`);
        for (const m of res.winningMoves) {
          assert.ok(rules[m.heapIndex].includes(m.take) && m.take <= heaps[m.heapIndex]);
          assert.equal(analyzePosition(m.resultingHeaps, rules).totalXor, 0);
        }
        if (res.outcome === "P") {
          for (let i = 0; i < heaps.length; i++)
            for (const s of rules[i])
              if (s <= heaps[i]) {
                const next = heaps.slice();
                next[i] -= s;
                assert.notEqual(analyzePosition(next, rules).totalXor, 0);
              }
        }
      }
});
