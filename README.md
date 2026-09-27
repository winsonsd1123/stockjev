# A股 Jev 观察助手

个人自用的 A 股观察工具。用 OpenRouter 上的 Jev 模型对全市场做优秀度打分，对观察池做买入判断，对持仓做卖出判断。结果只在网页上以概率展示，不自动交易，也不承诺收益。

单用户，无登录。

## 功能

- **发现**：点击后抓取必盈全市场列表与快照，粗筛掉 ST / \*ST、上市不足 60 天、近 5 日日均成交额低于 5000 万元的股票，再对候选股按日 K 特征打优秀度分。本轮排序后给出建议。无星系统池最多 10 只：均线连续两次走坏才移出，空位只补给连续两轮都进建议、且仍为多头并未封顶的票。全程约 5–15 分钟，页面需保持打开。
- **标星**：建议行上「标星」或手动输入代码会立刻进入观察池，不占系统池名额，也不等第二轮。标星票趋势走坏只提示，删除要手动确认。取消标星时若系统池已满会被拒绝。
- **买入轮询**：交易时段内，页面对观察池每 30 分钟问一次「当前是否适合立即买入」，展示概率。
- **卖出轮询**：录入持仓（代码 + 数量）后，与买入轮询同轮执行，问「当前是否适合立即卖出」。

交易时段按上证指数当日是否有 K 线判断是否为交易日，时段为 9:30–11:30、13:00–15:00。发现不受交易时段限制；非交易时段跳过轮询。

## 技术栈

| 项 | 选型 |
|---|---|
| 框架 | Next.js（App Router） |
| 数据库 | Supabase Postgres（只用持久化） |
| 模型 | OpenRouter Decisions API，`~typesafe/jev-latest` |
| 行情 | 必盈 API（列表、实时、日 K、5 分钟 K、指数）；装配点 `lib/market-data.ts` 的 `getMarketData()` |
| 部署 | Vercel Hobby |

Jev 只返回结构化概率（是非判断、有序打分），界面直接显示百分比。长任务由前端分批调用 step 接口推进，以避开 Vercel Hobby 单请求 60 秒限制。进度写在 `runs` 表，刷新或重开页面会续跑未完成任务。

## 本地开发

```bash
cp .env.example .env.local
npm install
npm run dev
```

打开 http://localhost:3000

`.env.local` 需要：

- `OPENROUTER_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `biying_api_key`

密钥只放在本地，不要提交仓库。

在 Supabase 中按序执行迁移：

1. [`001_init.sql`](supabase/migrations/001_init.sql) — 初始建表
2. [`002_int_ids.sql`](supabase/migrations/002_int_ids.sql) — 整数主键重建（会清空业务表）
3. [`003_last_price.sql`](supabase/migrations/003_last_price.sql) — 现价列
4. [`004_tags.sql`](supabase/migrations/004_tags.sql) — 规则标签列
5. [`005_watch_pool.sql`](supabase/migrations/005_watch_pool.sql) — 标星、趋势连续次数；已有观察池全部标星

表：`watchlist`、`holdings`、`runs`、`judgments`。

## 脚本

- `npm run dev` — 开发服务
- `npm run build` — 生产构建
- `npm start` — 启动生产服务
- `npm test` — 纯函数单元测试（粗筛、批次、Jev 解析、交易时段）
- `npm run lint` — ESLint

## 接口

| 端点 | 方法 | 作用 |
|---|---|---|
| `/api/discover` | POST | 创建发现任务 |
| `/api/discover/step` | POST | 推进一批发现（每步用满约 40 秒，进度在这一步进行中更新） |
| `/api/poll` | POST | 创建一轮轮询 |
| `/api/poll/step` | POST | 推进一批轮询（每批约 10 只，先观察池后持仓） |
| `/api/watchlist` | GET / POST / DELETE | 观察池 |
| `/api/holdings` | GET / POST / DELETE | 持仓 |
| `/api/status` | GET | 运行中任务、建议纳入、上次轮询时间、是否交易时段 |
