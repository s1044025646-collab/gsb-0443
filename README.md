# 有限减法取石游戏 Grundy 分析后端

纯本地离线运行的取石游戏（减法游戏）局面分析服务。技术栈：TypeScript + Node.js（>= 22，使用内置 `node:sqlite`）+ SQLite。只提供 HTTP API 与 CLI，无前端、无 Docker、无外部在线依赖。

## 游戏规则与理论前提

- 每个组合局面由若干堆组成；每堆有稳定编号（从 0 开始）、非负石子数，以及本堆允许一次拿走的正整数集合（各堆可以不同）。
- 两人轮流行动，每回合只选一堆，从中拿走一个属于该堆允许集合的正整数个石子。
- **正常玩法（normal play）**：轮到一方而没有任何合法动作时，该方输。一堆还有石子但所有允许拿取量都大于石子数时，该堆同样没有合法动作。空规则集合法，表示该堆永远不能行动。
- 所有结论都假设双方之后都按规则**最优行动**。

### Sprague–Grundy 与 mex

对单堆大小 `n`，其 Grundy 值递归定义为：

```
g(0) = 0
g(n) = mex { g(n - s) : s ∈ 本堆允许集合, s ≤ n }
```

其中 `mex(S)` 是未出现在集合 S 中的最小非负整数。例如允许集合为 {1,2} 时，g 值从 0 起按 0、1、2 循环（这是计算结果，不是硬编码公式）。

组合局面的值是各堆 Grundy 值的**按位异或**：

- 异或为 0：必败态（P 态），此时返回的必胜建议列表为空并附解释——不会编造一条"保证获胜"的着法。
- 异或非 0：必胜态（N 态）。对每个合法动作重新计算变化后的组合异或，**只**把结果恰好为 0 的动作列为必胜建议，按（堆编号, 拿取量）固定排序，重复分析输出顺序一致。

## 安装、构建、测试、启动

```powershell
npm install        # 仅开发依赖 typescript / @types/node
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 HTTP 服务（默认监听 127.0.0.1 的空闲端口）
$env:PORT=8080; npm start   # 指定端口
npm run demo       # 内置演示（需先 npm run build）
```

数据文件默认保存在项目内 `data/grundy.db`（可用环境变量 `GSB_DATA_DIR`、`GSB_DB_PATH` 覆盖）。重启后历史局面、动作链均可回放核对。

## HTTP API

所有错误返回 `{"error": {"code": "...", "message": "..."}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/rules` | 创建规则版本。Body: `{"rules": [[1,2],[1,3]]}`，返回 `ruleVersionId` 与 `duplicatesRemoved`（集合内重复值被规范化并报告，不改变规则含义） |
| POST | `/positions` | 导入组合局面。Body: `{"ruleVersionId": 1, "heaps": [1,2]}` |
| GET | `/positions/:id` | 查询当前局面 |
| POST | `/positions/:id/analyze` | 分析持久局面 |
| POST | `/analyze` | 直接分析临时局面。Body: `{"ruleVersionId":1,"heaps":[...]}` |
| GET | `/rules/:id/grundy?heap=0&n=6&window=20` | 某堆大小 n 的 Grundy 推导：每步给出可达 Grundy 集合与 mex；`window` 只截断展示，不影响真实计算 |
| POST | `/positions/:id/moves` | 执行合法动作。Body: `{"heapIndex":1,"take":1,"requestId":"可选幂等键","ruleVersionId":可选版本校验}` |
| POST | `/positions/:id/verify` | 核验外部建议着法是否合法且必胜 |
| GET | `/positions/:id/export` | 导出局面、规则、动作链、分析记录（JSON） |
| GET | `/positions/:id/replay` | 回放动作链并核对当前石子数 |
| GET | `/health` | 健康检查 |

### 动作执行语义

- 动作在事务中写入动作链并更新局面；非法拿取（不在允许集合、超过堆大小、堆编号越界）返回 409 且**不改变任何状态**。
- 携带 `ruleVersionId` 而版本不匹配时拒绝执行（409 `RULE_VERSION_MISMATCH`），防止旧历史套用新减法集合；修改规则应创建新规则版本与新局面。
- 携带相同 `requestId` 的重复请求返回首次结果（`duplicated: true`），不会重复减石子。
- 每执行一步 `turn` 递增，轮次自然交替。

### 主要错误码

`RULE_INVALID`（负数/小数/非数组规则）、`HEAPS_INVALID`、`HEAP_INDEX_INVALID`、`MOVE_ILLEGAL`、`RULE_VERSION_MISMATCH`、`RULE_VERSION_NOT_FOUND`、`POSITION_NOT_FOUND`、`LIMIT_EXCEEDED`（单堆 ≤ 10000、堆数 ≤ 100、总 DP 状态 ≤ 1,000,000）、`BAD_JSON`。

## CLI

```powershell
node dist/src/cli.js create-rule "[[1,2],[1,2]]"   # 创建规则版本
node dist/src/cli.js new-position 1 "[1,2]"        # 创建局面
node dist/src/cli.js analyze 1                     # 展示各堆 Grundy 值、总异或与必胜着法
node dist/src/cli.js grundy 1 0 6                  # 查看堆 0 到大小 6 的推导（可达集合 + mex）
node dist/src/cli.js move 1 1 1 my-request-1       # 执行动作（带幂等键）
node dist/src/cli.js verify 1 1 1                  # 核验外部建议
node dist/src/cli.js replay 1                      # 回放动作链
node dist/src/cli.js export 1                      # 导出 JSON
node dist/src/cli.js demo                          # 内置演示
```

## 测试与验证

`npm test` 覆盖：空局面、零堆、正大小但无合法动作、不同堆不同规则、拿取量恰好等于堆大小、多个并列必胜动作、规则重复值规范化、非法参数、动作幂等、失败事务回滚、重启后回放、HTTP 端到端。另有一个独立测试用**递归枚举完整组合对局树**（存在一步到必败态则必胜）与 Grundy 异或结论逐局面比对，并验证每条建议动作合法且结果异或为 0、必败态的所有合法动作都转为非零。

## 限制

- 单堆石子数 ≤ 10000、堆数 ≤ 100、总 DP 状态数 ≤ 1,000,000（可在 `src/grundy.ts` 顶部常量调整）。
- 单堆 Grundy 计算为 O(n × k)（k 为允许集合大小），不做整棵组合对局树的指数级搜索。
- `node:sqlite` 在 Node 25 仍标记为 experimental，会有启动警告，不影响功能。
- 服务监听 `127.0.0.1`，仅供本机使用，无鉴权。
