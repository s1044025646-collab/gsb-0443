import * as http from "node:http";
import { openDb } from "./db.js";
import { Service } from "./service.js";

function send(res: http.ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(s);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("请求体不是合法 JSON"), { code: "BAD_JSON" });
  }
}

export function createServer(service: Service): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (req.method === "POST" && url.pathname === "/rules") {
        const b = await readBody(req);
        return send(res, 201, service.createRuleVersion(b.rules));
      }
      if (req.method === "POST" && url.pathname === "/positions") {
        const b = await readBody(req);
        return send(res, 201, service.createPosition(Number(b.ruleVersionId), b.heaps));
      }
      if (req.method === "POST" && url.pathname === "/analyze") {
        const b = await readBody(req);
        return send(res, 200, service.analyze(null, Number(b.ruleVersionId), b.heaps));
      }
      if (parts[0] === "positions" && parts.length >= 2) {
        const id = Number(parts[1]);
        if (req.method === "POST" && parts[2] === "analyze") return send(res, 200, service.analyze(id));
        if (req.method === "POST" && parts[2] === "moves") {
          const b = await readBody(req);
          return send(res, 200, service.applyMove(id, Number(b.heapIndex), Number(b.take),
            b.requestId as string | undefined,
            b.ruleVersionId !== undefined ? Number(b.ruleVersionId) : undefined));
        }
        if (req.method === "POST" && parts[2] === "verify") {
          const b = await readBody(req);
          return send(res, 200, service.verifySuggestion(id, Number(b.heapIndex), Number(b.take)));
        }
        if (req.method === "GET" && parts[2] === "export") return send(res, 200, service.exportPosition(id));
        if (req.method === "GET" && parts[2] === "replay") return send(res, 200, service.replay(id));
        if (req.method === "GET" && parts.length === 2) return send(res, 200, service.getPosition(id));
      }
      if (req.method === "GET" && parts[0] === "rules" && parts.length === 3 && parts[2] === "grundy") {
        const heap = Number(url.searchParams.get("heap") ?? "0");
        const n = Number(url.searchParams.get("n") ?? "0");
        const win = url.searchParams.get("window");
        return send(res, 200, service.grundyDerivation(Number(parts[1]), heap, n, win ? Number(win) : undefined));
      }
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
      return send(res, 404, { error: { code: "NOT_FOUND", message: "路由不存在" } });
    } catch (e) {
      const er = e as Error & { code?: string };
      const status = er.code === "BAD_JSON" || er.code?.endsWith("INVALID") || er.code === "BAD_REQUEST" ? 400
        : er.code?.endsWith("NOT_FOUND") ? 404
        : er.code === "MOVE_ILLEGAL" || er.code === "RULE_VERSION_MISMATCH" ? 409
        : er.code === "LIMIT_EXCEEDED" ? 413
        : 500;
      return send(res, status, { error: { code: er.code ?? "INTERNAL", message: er.message } });
    }
  });
}

if (require.main === module) {
  const service = new Service(openDb());
  const server = createServer(service);
  const port = process.env.PORT ? Number(process.env.PORT) : 0;
  server.listen(port, () => {
    const addr = server.address();
    console.log(`Grundy 分析服务已启动: http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`);
  });
}
