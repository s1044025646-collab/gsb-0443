# 有限减法取石游戏 Grundy 分析后端

离线局面分析服务：TypeScript + Node.js + SQLite（`node:sqlite`，零第三方运行时依赖），仅提供 HTTP API 与 CLI，无前端。

## 规则与理论

- 每堆有稳定编号、非负石子数、本堆允许一次拿走的正整数集合（各堆可不同）。
- 两人轮流只选一堆执行一个合法拿取；轮到时没有任何合法动作的一方输（正常玩法，normal play）。
- 一堆还有石子但所有允许拿取量都大于石子数时，该堆同样没有合法动作。

**Sprague–Grundy**：`g(0) = 0`；`g(n) = mex{ g(n-s) : s ∈ S, s <= n }`，其中 mex 是未出现在集合中的最小非负整数。组合局面的值为各堆 Grundy 值的按位异或：0 为必败态（P），非零为必胜态（N）。结论假设双方之后都按规则最优行动。只列出使异或归零的动作为必胜建议；本来必败时返回空建议并解释。

## 运行要求

- Windows 本地，Node.js ≥ 22（使用内置 `node:sqlite`，当前在 Node 25 验证），不需要 Docker / WSL / 外部服务。

## 命令

```powershell
npm install        # 仅安装 TypeScript 开发依赖
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 HTTP 服务（默认自动选择空闲端口；--port=8080 或 PORT 环境变量指定）
npm run demo       # CLI 内置演示：{1,2} 两堆 [1,2] 的完整流程
```

数据保存在项目内 `data/grundy.db`（可用 `DATA_DIR` / `DB_PATH` 覆盖）。

## CLI

```
node dist/src/cli.js create-ruleset  --name N --piles "[{\"key\":\"A\",\"moves\":[1,2]}]"
node dist/src/cli.js import-position --ruleset ID --label L --stones "{\"A\":5}"
node dist/src/cli.js analyze         --position ID
node dist/src/cli.js grundy          --ruleset ID --pile KEY --n N
node dist/src/cli.js move            --position ID --pile KEY --take N [--ruleset ID] [--request RID]
node dist/src/cli.js verify          --position ID --moves "[{\"pileKey\":\"A\",\"take\":1}]"
node dist/src/cli.js replay          --position ID
node dist/src/cli.js export          --position ID
```

`analyze` 展示各堆 Grundy 值、总异或与一步必胜操作。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/rulesets` | 创建规则版本 `{name, piles:[{key, moves}]}`，返回规范化后的集合与重复值报告 |
| POST | `/positions` | 导入组合局面 `{rulesetId, label, stones:{key:n}}` |
| POST | `/positions/:id/analyze` | 分析当前局面并保存分析记录 |
| GET | `/rulesets/:id/grundy/:pileKey/:n?window=20` | 某堆大小 n 的 Grundy 推导（可达集合、mex、展示窗口） |
| POST | `/positions/:id/moves` | 执行动作 `{pileKey, take, expectedRulesetId?, requestId?}` |
| POST | `/positions/:id/verify` | 核验外部建议 `{moves:[{pileKey, take}]}` |
| GET | `/positions/:id/replay` | 回放每一步并给出当前石子数 |
| GET | `/positions/:id/export` | 导出规则、局面、动作链与分析历史 |

错误统一为 `{"error":{"code","message"}}`，错误码：`INVALID_RULESET`、`INVALID_POSITION`、`INVALID_MOVE`、`VERSION_MISMATCH`、`LIMIT_EXCEEDED`、`NOT_FOUND`、`BAD_JSON`、`BAD_PARAM`。

## 一致性与持久化

- 执行动作在 SQLite 中保存前后局面与规则版本，轮次交替（player 0/1）。
- `requestId` 幂等：重复请求返回已存在的动作记录，不重复减石子。
- `expectedRulesetId` 不匹配返回 `VERSION_MISMATCH`（409）。
- 修改规则需创建新规则版本与新局面；旧历史始终按其原规则版本分析。
- 重启后 `replay` 可逐步回放并核对当前石子数。

## 校验与限制

- 拿取量必须为正整数：负数、小数报 `INVALID_RULESET`；空规则集合法（该堆永远不能行动）；重复值去重并在创建时报告。
- 限制：堆数 ≤ 64，单堆石子 ≤ 10000，总 DP 状态 ≤ 200000（超出报 `LIMIT_EXCEEDED`）。正式计算只做每堆 O(n·|S|) 的 DP，不搜索组合对局树。
- Grundy 推导的展示窗口（`window` 参数）只影响展示，真实 mex 基于完整可达集合计算。

## 测试

`npm test` 覆盖：{1,2} 的 0,1,2 循环、两堆 [1,2] 异或为 3 及拿取后归零、空局面/零堆/无合法动作/空规则集/拿取量等于堆大小/多并列必胜动作排序、200 组随机小状态 Grundy 异或结论与独立递归枚举对拍、建议合法性与归零验证、必败态所有动作转非零、幂等与版本校验、失败事务、重启回放、导出。

## 已知限制

- `node:sqlite` 仍带 Experimental 警告，不影响功能。
- 单进程服务，无鉴权，面向本地单机使用。
