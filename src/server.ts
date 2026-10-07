import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { Service, ApiError } from "./service";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const DB_PATH = process.env.DB_PATH ?? path.join(DATA_DIR, "grundy.db");

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError("BAD_JSON", "请求体不是合法 JSON");
  }
}

export function findFreePort(preferred = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(preferred, () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on("error", reject);
  });
}

export async function startServer(port?: number): Promise<{ server: http.Server; port: number }> {
  const service = new Service(DB_PATH);
  const actualPort = port ?? (await findFreePort());

  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const p = url.pathname;
      const body = req.method === "POST" ? await readBody(req) : {};
      const num = (s: string | null, name: string) => {
        const n = Number(s);
        if (!Number.isInteger(n)) throw new ApiError("BAD_PARAM", `参数 ${name} 必须是整数`);
        return n;
      };

      if (req.method === "POST" && p === "/rulesets") {
        send(201, service.createRuleset(body.name, body.piles));
      } else if (req.method === "POST" && p === "/positions") {
        send(201, service.createPosition(num(String(body.rulesetId), "rulesetId"), body.label ?? "", body.stones ?? {}));
      } else if (req.method === "POST" && /^\/positions\/\d+\/analyze$/.test(p)) {
        send(200, service.analyzePosition(Number(p.split("/")[2])));
      } else if (req.method === "GET" && /^\/rulesets\/\d+\/grundy\/[^/]+\/\d+$/.test(p)) {
        const parts = p.split("/");
        const ws = url.searchParams.get("window");
        send(200, service.grundyDerivation(Number(parts[2]), decodeURIComponent(parts[4]), Number(parts[5]), ws ? Number(ws) : undefined));
      } else if (req.method === "POST" && /^\/positions\/\d+\/moves$/.test(p)) {
        send(201, service.executeMove(Number(p.split("/")[2]), body.pileKey, body.take, body.expectedRulesetId, body.requestId));
      } else if (req.method === "POST" && /^\/positions\/\d+\/verify$/.test(p)) {
        send(200, service.verifySuggestion(Number(p.split("/")[2]), body.moves ?? []));
      } else if (req.method === "GET" && /^\/positions\/\d+\/replay$/.test(p)) {
        send(200, service.replay(Number(p.split("/")[2])));
      } else if (req.method === "GET" && /^\/positions\/\d+\/export$/.test(p)) {
        send(200, service.exportPosition(Number(p.split("/")[2])));
      } else if (req.method === "GET" && p === "/health") {
        send(200, { ok: true });
      } else {
        send(404, { error: { code: "NOT_FOUND", message: `未知路由: ${req.method} ${p}` } });
      }
    } catch (e: any) {
      if (e instanceof ApiError) {
        send(e.status, { error: { code: e.code, message: e.message } });
      } else {
        send(500, { error: { code: "INTERNAL", message: String(e?.message ?? e) } });
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(actualPort, resolve));
  return { server, port: actualPort };
}

if (require.main === module) {
  const arg = process.argv.find((a) => a.startsWith("--port="));
  const port = arg ? Number(arg.split("=")[1]) : process.env.PORT ? Number(process.env.PORT) : undefined;
  startServer(port).then(({ port }) => {
    console.log(`Grundy 分析服务已启动: http://localhost:${port} (数据目录: ${DATA_DIR})`);
  });
}
