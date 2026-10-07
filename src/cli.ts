import * as path from "node:path";
import { Service } from "./service";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const DB_PATH = process.env.DB_PATH ?? path.join(DATA_DIR, "grundy.db");

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function printAnalysis(a: ReturnType<Service["analyzePosition"]>): void {
  console.log(`局面 #${a.positionId}（规则版本 ${a.rulesetId}，已执行 ${a.moveSeq} 步）`);
  for (const p of a.pileGrundies) {
    console.log(`  堆 ${p.pileKey}: 石子=${p.stones}  Grundy=${p.grundy}`);
  }
  console.log(`  总异或 = ${a.xor}  =>  ${a.outcome === "N" ? "必胜态" : "必败态"}`);
  if (a.winningMoves.length > 0) {
    console.log("  必胜着法:");
    for (const m of a.winningMoves) {
      console.log(`    从堆 ${m.pileKey} 拿 ${m.take} 颗 -> 异或归零`);
    }
  }
  console.log(`  说明: ${a.explanation}`);
}

function demo(svc: Service): void {
  console.log("== 演示：减法集 {1,2}，两堆 [1,2] ==\n");
  const rs = svc.createRuleset("demo-{1,2}", [
    { key: "A", moves: [1, 2] },
    { key: "B", moves: [1, 2] },
  ]);
  console.log(`规则版本 #${rs.id} 已创建`);
  const pos = svc.createPosition(rs.id, "demo", { A: 1, B: 2 });
  console.log(`局面 #${pos.id} 初态: ${JSON.stringify(pos.initialStones)}\n`);
  printAnalysis(svc.analyzePosition(pos.id));
  console.log("\n执行: 从堆 B 拿 1 颗");
  const mv = svc.executeMove(pos.id, "B", 1, rs.id, "demo-move-1");
  console.log(`  步 ${mv.seq} 玩家${mv.player} 后: ${JSON.stringify(mv.after)}\n`);
  printAnalysis(svc.analyzePosition(pos.id));
  console.log("\nGrundy 推导（堆 B, n=7）:");
  const d = svc.grundyDerivation(rs.id, "B", 7);
  console.log(`  可达集合: ${JSON.stringify(d.reachable)}  mex=${d.mex}  g(7)=${d.grundy}`);
  console.log(`  窗口 g(${d.windowFrom}..7) = [${d.window.join(", ")}]`);
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  const svc = new Service(DB_PATH);
  try {
    switch (cmd) {
      case "create-ruleset": {
        const name = argValue(rest, "name") ?? "unnamed";
        const piles = JSON.parse(argValue(rest, "piles") ?? "");
        console.log(JSON.stringify(svc.createRuleset(name, piles), null, 2));
        break;
      }
      case "import-position": {
        const rulesetId = Number(argValue(rest, "ruleset"));
        const stones = JSON.parse(argValue(rest, "stones") ?? "{}");
        console.log(JSON.stringify(svc.createPosition(rulesetId, argValue(rest, "label") ?? "", stones), null, 2));
        break;
      }
      case "analyze":
        printAnalysis(svc.analyzePosition(Number(argValue(rest, "position"))));
        break;
      case "grundy":
        console.log(JSON.stringify(
          svc.grundyDerivation(Number(argValue(rest, "ruleset")), argValue(rest, "pile")!, Number(argValue(rest, "n"))),
          null, 2));
        break;
      case "move":
        console.log(JSON.stringify(
          svc.executeMove(
            Number(argValue(rest, "position")),
            argValue(rest, "pile")!,
            Number(argValue(rest, "take")),
            argValue(rest, "ruleset") ? Number(argValue(rest, "ruleset")) : undefined,
            argValue(rest, "request")
          ), null, 2));
        break;
      case "verify":
        console.log(JSON.stringify(
          svc.verifySuggestion(Number(argValue(rest, "position")), JSON.parse(argValue(rest, "moves") ?? "[]")),
          null, 2));
        break;
      case "replay":
        console.log(JSON.stringify(svc.replay(Number(argValue(rest, "position"))), null, 2));
        break;
      case "export":
        console.log(JSON.stringify(svc.exportPosition(Number(argValue(rest, "position"))), null, 2));
        break;
      case "demo":
        demo(svc);
        break;
      default:
        console.log(`用法: node dist/src/cli.js <命令> [参数]
  create-ruleset   --name N --piles '[{"key":"A","moves":[1,2]}]'
  import-position  --ruleset ID --label L --stones '{"A":5}'
  analyze          --position ID
  grundy           --ruleset ID --pile KEY --n N
  move             --position ID --pile KEY --take N [--ruleset ID] [--request RID]
  verify           --position ID --moves '[{"pileKey":"A","take":1}]'
  replay           --position ID
  export           --position ID
  demo             内置演示`);
    }
  } finally {
    svc.close();
  }
}

main();
