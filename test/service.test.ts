import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openDb } from "../src/db.js";
import { Service } from "../src/service.js";
import { createServer } from "../src/server.js";

function tmpService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsb-"));
  return { service: new Service(openDb(path.join(dir, "t.db"))), dbPath: path.join(dir, "t.db") };
}

test("服务流程：建规则/局面/分析/动作/回放/导出", () => {
  const { service } = tmpService();
  const rv = service.createRuleVersion([[1, 2, 2], [1, 2]]);
  assert.deepEqual(rv.duplicatesRemoved[0], [2]);
  const pos = service.createPosition(rv.ruleVersionId, [1, 2]);
  const a = service.analyze(pos.positionId);
  assert.equal(a.totalXor, 3);
  const mv = service.applyMove(pos.positionId, 1, 1, "req-1");
  assert.deepEqual(mv.heaps, [1, 1]);
  const a2 = service.analyze(pos.positionId);
  assert.equal(a2.outcome, "P");
  const replay = service.replay(pos.positionId);
  assert.equal(replay.consistent, true);
  assert.equal(replay.steps.length, 1);
  const exp = service.exportPosition(pos.positionId);
  assert.equal(exp.moves.length, 1);
});

test("幂等：相同 requestId 不重复减石子", () => {
  const { service } = tmpService();
  const rv = service.createRuleVersion([[1, 2]]);
  const pos = service.createPosition(rv.ruleVersionId, [5]);
  const m1 = service.applyMove(pos.positionId, 0, 2, "same");
  const m2 = service.applyMove(pos.positionId, 0, 2, "same");
  assert.equal(m2.duplicated, true);
  assert.deepEqual(service.getPosition(pos.positionId).heaps, [3]);
  assert.equal(m1.moveNo, m2.moveNo);
});

test("非法拿取、错版本被拒绝且不改变状态", () => {
  const { service } = tmpService();
  const rv = service.createRuleVersion([[1, 2]]);
  const rv2 = service.createRuleVersion([[1, 3]]);
  const pos = service.createPosition(rv.ruleVersionId, [2]);
  assert.throws(() => service.applyMove(pos.positionId, 0, 3), /允许集合/);
  assert.throws(() => service.applyMove(pos.positionId, 0, 5), /允许集合/);
  assert.throws(() => service.applyMove(pos.positionId, 9, 1), /越界/);
  assert.throws(() => service.applyMove(pos.positionId, 0, 1, undefined, rv2.ruleVersionId), /规则版本/);
  assert.deepEqual(service.getPosition(pos.positionId).heaps, [2]);
});

test("失败事务回滚：动作表与局面一致", () => {
  const { service } = tmpService();
  const rv = service.createRuleVersion([[1]]);
  const pos = service.createPosition(rv.ruleVersionId, [1]);
  try { service.applyMove(pos.positionId, 0, 2); } catch { /* 忽略 */ }
  const replay = service.replay(pos.positionId);
  assert.equal(replay.consistent, true);
  assert.equal(replay.steps.length, 0);
});

test("重启后可回放并核对石子数", () => {
  const { service, dbPath } = tmpService();
  const rv = service.createRuleVersion([[1, 2]]);
  const pos = service.createPosition(rv.ruleVersionId, [4]);
  service.applyMove(pos.positionId, 0, 1);
  service.applyMove(pos.positionId, 0, 2);
  const s2 = new Service(openDb(dbPath));
  const replay = s2.replay(pos.positionId);
  assert.equal(replay.consistent, true);
  assert.deepEqual(replay.current, [1]);
  assert.equal(replay.steps.length, 2);
});

test("核验外部建议", () => {
  const { service } = tmpService();
  const rv = service.createRuleVersion([[1, 2], [1, 2]]);
  const pos = service.createPosition(rv.ruleVersionId, [1, 2]);
  assert.equal(service.verifySuggestion(pos.positionId, 1, 1).winning, true);
  assert.equal(service.verifySuggestion(pos.positionId, 0, 1).winning, false);
  assert.equal(service.verifySuggestion(pos.positionId, 0, 5).legal, false);
});

test("Grundy 推导含可达集合与 mex，窗口截断仅影响展示", () => {
  const { service } = tmpService();
  const rv = service.createRuleVersion([[1, 2]]);
  const d = service.grundyDerivation(rv.ruleVersionId, 0, 6, 3);
  assert.equal(d.steps.length, 3);
  assert.equal(d.steps[0].truncated, true);
  assert.equal(d.steps[d.steps.length - 1].mex, 0); // g(6)=0
  const full = service.grundyDerivation(rv.ruleVersionId, 0, 6);
  assert.equal(full.steps[full.steps.length - 1].mex, 0);
});

test("HTTP API 端到端", async () => {
  const { service } = tmpService();
  const server = createServer(service);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
  const post = async (p: string, body: unknown) => {
    const res = await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  };
  const rv = await post("/rules", { rules: [[1, 2], [1, 2]] });
  assert.equal(rv.status, 201);
  const pos = await post("/positions", { ruleVersionId: rv.json.ruleVersionId, heaps: [1, 2] });
  assert.equal(pos.status, 201);
  const an = await post(`/positions/${pos.json.positionId}/analyze`, {});
  assert.equal(an.json.totalXor, 3);
  const mv = await post(`/positions/${pos.json.positionId}/moves`, { heapIndex: 1, take: 1, requestId: "api-1" });
  assert.deepEqual(mv.json.heaps, [1, 1]);
  const dup = await post(`/positions/${pos.json.positionId}/moves`, { heapIndex: 1, take: 1, requestId: "api-1" });
  assert.equal(dup.json.duplicated, true);
  const bad = await post(`/positions/${pos.json.positionId}/moves`, { heapIndex: 0, take: 5 });
  assert.equal(bad.status, 409);
  const replay = await fetch(`${base}/positions/${pos.json.positionId}/replay`);
  assert.equal((await replay.json() as { consistent: boolean }).consistent, true);
  const g = await fetch(`${base}/rules/${rv.json.ruleVersionId}/grundy?heap=0&n=5`);
  assert.equal(g.status, 200);
  const notFound = await fetch(`${base}/positions/999`);
  assert.equal(notFound.status, 404);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
