# A股 Jev 观察助手 — PRD

> 版本：v1.0 ｜ 日期：2026-09-24 ｜ 状态：已确认
> 定位：个人自用的 A 股 AI 辅助观察工具，最简方案，单用户，无登录。

## 1. 概述

- **做什么**：用 Jev 决策模型（OpenRouter）对 A 股全市场做「优秀度打分」，对自选观察池做买入判断、对录入持仓做卖出判断，全部结果在网页查看。
- **不为做什么**：不自动交易、不推送通知、不做回测、不承诺收益。工具只产出结构化概率，决策由人完成。
- **用户**：本人一个。

## 2. 技术栈与部署约束

| 项 | 选型 | 说明 |
|---|---|---|
| 框架 | Next.js（App Router） | 前后端一体 |
| 数据库 | Supabase Postgres | 仅持久化，不用 Auth / Realtime / Storage |
| AI | OpenRouter Decisions API | `POST https://openrouter.ai/api/alpha/decisions`，模型 `~typesafe/jev-latest` |
| 行情数据 | 东方财富公开接口 | 无需 key：全市场快照（排行分页）/ 日K线 / 分钟K线 / 指数K线 |
| 部署 | Vercel Hobby | 硬约束：单请求 ≤60s、Cron 仅每天级精度 → 一切长任务由**前端驱动分批**完成，不用服务端定时 |

环境变量：`OPENROUTER_API_KEY`、`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`（仅服务端使用）。

### Jev 模型要点（影响产品设计）

- Jev **不生成文字**，只返回带概率的结构化判断：`noul`（是非概率）、`choice`（选项）、`score`（有序量规打分）。
- 输入 = `state`（结构化数据）+ `questions`；一次调用可带多个问题。
- 计费仅输入 token（$0.042/M），输出免费，P50 延迟约 0.23s，上下文 32K。
- 界面直接展示概率百分比，无「分析报告」类文本。

## 3. 功能需求

### F1 发现（全市场扫描 → Top 10 观察池）

1. 用户点击「发现」按钮 → 创建 discover 任务 → 前端循环调用 step 接口分批推进，页面展示进度条。
2. 第一步：抓全市场快照（东财排行接口分页约 30 页），**粗筛**剔除：ST / *ST、上市不足 60 天、日均成交额 < 5000 万元。剩余约 2000-3000 只为候选池。
3. 之后每批 30 只：每只抓一周日 K 线（5 根 OHLCV），连同快照指标组装为 state → Jev `score`（0-100 优秀度）→ 结果写入 judgments。
4. 全部完成：按分数排序，**前 10 写入 watchlist（source=ai）**；同时以最新一轮发现的 ai 池整体替换上一轮 ai 池。
5. 用户可随时手动输入 6 位股票代码加入 watchlist（source=manual）。**manual 股票永不被发现流程覆盖或删除**，故池内可超过 10 只。
6. 发现不受交易时段限制，随时可跑；单次全程约 5-15 分钟（需保持页面打开）。

### F2 买入轮询（观察池 → 是否可买入）

1. 轮询对象：watchlist 全部股票（ai + manual）。
2. 触发：**仅前端驱动**。页面打开时若距上次成功轮询 >30 分钟且处于交易时段 → 立即启动；之后每 30 分钟自动一轮。页面关闭即暂停。
3. 每轮每批 10 只：每只抓当日 5 分钟 K 线（开盘至今约 48 根）+ 批量实时快照 → Jev `noul`「结合大盘背景与个股分时数据，当前是否适合立即买入」→ 记录概率。

### F3 卖出轮询（持仓 → 是否可卖出）

1. 用户录入持仓：6 位代码 + 持股数量，存 holdings 表，可增删。
2. 轮询机制与 F2 完全一致（共用同一轮询循环与批次端点，仅提问不同）：Jev `noul`「当前是否适合立即卖出」。
3. F2 与 F3 同轮执行：先处理 watchlist，再处理 holdings。

## 4. 数据方案

| 场景 | state 组成 | 请求数 |
|---|---|---|
| F1 发现（每只） | 快照指标：名称、总市值、PE、PB、换手率、量比、当日涨跌幅 ＋ 一周日 K 线 5 根 | 快照已由粗筛步骤抓得，K 线每只 1 次 |
| F2/F3 轮询（每轮） | 共享背景：上证指数当日分时 + 近 5 日走势（1 次请求，全部股票共用）；批量个股实时快照：量比、当日涨跌幅（1 次请求/批） | 每轮固定 +2 次 |
| F2/F3 轮询（每只） | 当日 5 分钟 K 线约 48 根 | 每只 1 次 |

- **交易时段判定**：以「上证指数当日 K 线是否有数据」判断是否交易日，避免维护节假日日历；交易时段 = 交易日 9:30-11:30、13:00-15:00。
- 明确不采集：新闻、公告、北向资金、主力资金流（逐只额外请求且不符合 Jev 结构化输入设计，效果不满意再迭代）。

## 5. 数据库设计（4 张表）

```sql
-- 观察池
watchlist (
  id uuid pk, market text,        -- sh / sz / bj
  code text, name text,
  source text,                    -- 'ai' | 'manual'
  score numeric null,             -- 最近一次发现得分（manual 为空）
  added_at timestamptz,
  unique (market, code)           -- 防止手动重复添加 / 与发现写入冲突
)

-- 持仓
holdings (
  id uuid pk, market text, code text, name text,
  quantity int, added_at timestamptz
)

-- 任务运行（进度可恢复）
runs (
  id uuid pk, type text,          -- 'discover' | 'poll'（每轮轮询一条 run 记录）
  status text,                    -- 'running' | 'completed'
  progress jsonb,                 -- {processed, total, cursor, failedCodes[]}
  created_at timestamptz, finished_at timestamptz null
)

-- 判断历史
judgments (
  id uuid pk, run_id uuid, market text, code text,
  kind text,                      -- 'score' | 'buy' | 'sell'
  probability numeric,            -- 0-1
  details jsonb,                  -- 原始响应摘要（分数档位概率等）
  created_at timestamptz
)
```

## 6. API 设计

| 端点 | 方法 | 职责 |
|---|---|---|
| `/api/discover` | POST | 创建/重置 discover run |
| `/api/discover/step` | POST | 推进一批（首批=快照+粗筛；其后每批 30 只抓数+打分），返回 `{done, processed, total}` |
| `/api/poll` | POST | 启动一轮 poll run（薄封装：仅创建 run 记录） |
| `/api/poll/step` | POST | 推进一批（每批 10 只；先 watchlist 后 holdings） |
| `/api/watchlist` | GET / POST / DELETE | 观察池增删查 |
| `/api/holdings` | GET / POST / DELETE | 持仓增删查 |

## 7. 页面设计（单页 `/`，三个区块）

1. **工具栏**：「发现」按钮 + 进度条（processed/total）；手动添加股票输入框（代码）。
2. **观察池表格**：代码、名称、来源（ai/manual）、AI 分、最新买入概率%、更新时间、删除操作；行展开显示最近 5 次判断历史。
3. **持仓区块**：录入表单（代码 + 数量）；表格：代码、名称、数量、最新卖出概率%、更新时间、删除。

前端驱动逻辑：打开页面 → 检查 runs 是否有未完成任务 → 有则继续驱动 step 循环；距上次成功轮询 >30 分钟且交易时段 → 启动轮询；`setInterval` 30 分钟重复。

## 8. 超时规避与错误处理

- **超时**：发现批 ≤30 只、轮询批 ≤10 只，单请求目标 <10s（远低于 Vercel Hobby 60s 上限）；批次内数据抓取并发（约 10）、Jev 调用受其低延迟特性保障。
- **恢复**：页面关闭/刷新 = 任务暂停；进度在 runs 表，重开页面自动续跑。
- **单只数据抓取失败**：跳过并计入 `failedCodes`，不阻塞批次。
- **Jev 调用失败**：重试 1 次；仍失败标记该只本轮无结果，下一轮轮询自然补齐（发现中失败的股票不参与排序）。
- **非交易时段**：轮询自动跳过；发现不受限。

## 9. 明确不做（YAGNI）

无用户系统与登录、无通知推送、无自动交易、无 K 线图表（纯表格）、不缓存历史行情、无回测、无多用户。

## 10. 验收标准

1. 点击「发现」→ 5-15 分钟内完成，观察池出现本轮 Top 10，手动添加的股票保留。
2. 交易时段保持页面打开 → 每 30 分钟自动产出新一批买入/卖出概率。
3. 刷新或关闭重开页面 → 任务进度与判断历史不丢失，未完成任务自动续跑。
4. 部署至 Vercel Hobby 无函数超时报错。
5. 单次全市场发现 Jev 成本 ≤ $1；单轮轮询 ≤ $0.02。

## 11. 测试策略（最简）

- 单元测试仅覆盖纯逻辑：粗筛规则、批次切分、Jev 响应解析、交易时段判定。
- 其余靠手动冒烟（发现全流程、轮询全流程、断点续跑）。

## 12. 密钥与外部配置

密钥仅存放于本地 `.env.local`（勿提交仓库），变量名见 `.env.example`：

- `OPENROUTER_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Jev 模型：`~typesafe/jev-latest`（文档：https://openrouter.ai/~typesafe/jev-latest）

