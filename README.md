# A股 Jev 观察助手

个人自用的 A 股 AI 辅助观察工具（Next.js + Supabase + OpenRouter Jev + 东财行情）。

## 本地开发

```bash
cp .env.example .env.local
# 填入 OPENROUTER_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY

npm install
npm run dev
```

打开 http://localhost:3000

## 脚本

- `npm run dev` — 开发服务
- `npm run build` — 生产构建
- `npm test` — 纯函数单元测试
- `npm run lint` — ESLint

## 数据库

执行 [`supabase/migrations/001_init.sql`](supabase/migrations/001_init.sql) 建表。

## 说明

密钥只放在 `.env.local`，勿提交仓库。长任务（发现 / 轮询）由前端分批驱动 step 接口，适配 Vercel Hobby 60s 限制。
