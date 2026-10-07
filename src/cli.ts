import { openDb } from "./db.js";
import { Service } from "./service.js";
import { analyzePosition, deriveGrundy, normalizeRule, validateHeaps } from "./grundy.js";

const service = new Service(openDb());

function parseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { throw new Error(`无法解析 JSON: ${s}`); }
}

function printAnalysis(a: ReturnType<typeof service.analyze>) {
  console.log(`各堆 Grundy 值: [${a.heapGrundies.join(", ")}]`);
  console.log(`总异或: ${a.totalXor}  =>  ${a.outcome === "P" ? "必败态(P)" : "必胜态(N)"}`);
  console.log(a.explanation);
  if (a.winningMoves.length > 0) {
    console.log("必胜着法:");
    for (const m of a.winningMoves)
      console.log(`  堆 ${m.heapIndex} 拿 ${m.take} -> [${m.resultingHeaps.join(", ")}] (异或=0)`);
  }
}

function demo() {
  const rv = service.createRuleVersion([[1, 2], [1, 2]]);
  console.log(`规则版本 ${rv.ruleVersionId}: 两堆均允许拿 {1,2}`);
  const pos = service.createPosition(rv.ruleVersionId, [1, 2]);
  console.log(`局面 ${pos.positionId}: [1, 2]`);
  printAnalysis(service.analyze(pos.positionId));
  const d = service.grundyDerivation(rv.ruleVersionId, 1, 6);
  console.log(`\n堆1 Grundy 推导 (规则 {${d.moves.join(",")}}):`);
  for (const s of d.steps)
    console.log(`  g(${s.n}) = mex{${s.reachableSet.join(",")}} = ${s.mex}`);
  const mv = service.applyMove(pos.positionId, 1, 1, "demo-1");
  console.log(`\n执行: 堆1 拿1 -> [${mv.heaps.join(", ")}]`);
  printAnalysis(service.analyze(pos.positionId));
  const replay = service.replay(pos.positionId);
  console.log(`回放一致: ${replay.consistent}`);
}

const [cmd, ...args] = process.argv.slice(2);
try {
  switch (cmd) {
    case "create-rule": {
      const r = service.createRuleVersion(parseJson(args[0]));
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case "new-position": {
      console.log(JSON.stringify(service.createPosition(Number(args[0]), parseJson(args[1])), null, 2));
      break;
    }
    case "analyze": {
      printAnalysis(service.analyze(Number(args[0])));
      break;
    }
    case "grundy": {
      const d = service.grundyDerivation(Number(args[0]), Number(args[1]), Number(args[2]), args[3] ? Number(args[3]) : undefined);
      for (const s of d.steps)
        console.log(`g(${s.n}) = mex{${s.reachableSet.join(",")}} = ${s.mex}${s.truncated ? "  (窗口截断，仅展示)" : ""}`);
      break;
    }
    case "move": {
      console.log(JSON.stringify(service.applyMove(Number(args[0]), Number(args[1]), Number(args[2]), args[3]), null, 2));
      break;
    }
    case "verify": {
      console.log(JSON.stringify(service.verifySuggestion(Number(args[0]), Number(args[1]), Number(args[2])), null, 2));
      break;
    }
    case "export": {
      console.log(JSON.stringify(service.exportPosition(Number(args[0])), null, 2));
      break;
    }
    case "replay": {
      const r = service.replay(Number(args[0]));
      console.log(`初态: [${r.initial.join(", ")}]`);
      for (const s of r.steps) console.log(`  #${s.moveNo} 堆${s.heapIndex} 拿${s.take} -> [${s.heaps.join(", ")}] ${s.ok ? "OK" : "不一致!"}`);
      console.log(`当前: [${r.current.join(", ")}] 一致=${r.consistent}`);
      break;
    }
    case "demo":
      demo();
      break;
    default:
      console.log(`用法: node dist/src/cli.js <命令>
  create-rule '[[1,2],[1,3]]'     创建规则版本
  new-position <rvId> '[1,2]'     创建局面
  analyze <posId>                 分析局面
  grundy <rvId> <heap> <n> [win]  查看 Grundy 推导
  move <posId> <heap> <take> [reqId]  执行动作
  verify <posId> <heap> <take>    核验外部建议
  export <posId>                  导出 JSON
  replay <posId>                  回放动作链
  demo                            内置演示`);
  }
} catch (e) {
  const er = e as Error & { code?: string };
  console.error(`错误 [${er.code ?? "INTERNAL"}]: ${er.message}`);
  process.exitCode = 1;
}
