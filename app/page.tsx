"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";

type Judgment = {
  id: string;
  kind: string;
  probability: number;
  created_at: string;
  details?: Record<string, unknown>;
};

type WatchItem = {
  id: string;
  market: string;
  code: string;
  name: string;
  source: "ai" | "manual";
  score: number | null;
  latestBuyProbability: number | null;
  latestBuyAt: string | null;
  judgments: Judgment[];
};

type HoldingItem = {
  id: string;
  market: string;
  code: string;
  name: string;
  quantity: number;
  latestSellProbability: number | null;
  latestSellAt: string | null;
};

type Status = {
  running: {
    id: string;
    type: "discover" | "poll";
    progress: { processed?: number; total?: number; phase?: string };
  } | null;
  lastPollAt: string | null;
  tradingDay: boolean;
  tradingSession: boolean;
};

function pct(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

const POLL_INTERVAL_MS = 30 * 60 * 1000;

type StepEvent = { level: "info" | "ok" | "fail"; text: string };

type RunProgress = {
  processed: number;
  total: number;
  label: string;
  phase: string;
};

const PHASE_LABEL: Record<string, string> = {
  snapshot: "抓取快照",
  score: "优秀度打分",
  commit: "写入观察池",
  context: "抓取大盘",
  items: "买卖判断",
  done: "已完成",
};

export default function HomePage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [watchlist, setWatchlist] = useState<WatchItem[]>([]);
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [progress, setProgress] = useState<RunProgress>({
    processed: 0,
    total: 0,
    label: "",
    phase: "",
  });
  const [log, setLog] = useState<StepEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const [addCode, setAddCode] = useState("");
  const [holdCode, setHoldCode] = useState("");
  const [holdQty, setHoldQty] = useState("100");
  const [expanded, setExpanded] = useState<string | null>(null);
  const driving = useRef(false);
  const bootstrapped = useRef(false);

  const refreshLists = useCallback(async () => {
    const [w, h] = await Promise.all([
      fetch("/api/watchlist").then((r) => r.json()),
      fetch("/api/holdings").then((r) => r.json()),
    ]);
    if (w.items) setWatchlist(w.items);
    if (h.items) setHoldings(h.items);
  }, []);

  const fetchStatus = useCallback(async () => {
    const s = (await fetch("/api/status").then((r) => r.json())) as Status;
    setStatus(s);
    return s;
  }, []);

  const driveSteps = useCallback(
    async (type: "discover" | "poll", runId?: string) => {
      if (driving.current) return;
      driving.current = true;
      setBusy(true);
      try {
        let done = false;
        let currentRunId = runId;
        while (!done) {
          setMessage(
            type === "discover" ? "正在推进发现…" : "正在推进轮询…"
          );
          const res = await fetch(`/api/${type}/step`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ runId: currentRunId }),
          });
          const json = await res.json();
          if (!res.ok) throw new Error(json.error ?? "step 失败");
          currentRunId = json.runId;
          const phase = String(json.phase ?? "");
          setProgress({
            processed: json.processed ?? 0,
            total: json.total ?? 0,
            phase,
            label: PHASE_LABEL[phase] ?? phase,
          });
          if (json.message) setMessage(json.message);
          if (Array.isArray(json.events) && json.events.length > 0) {
            setLog((prev) => [...prev, ...json.events].slice(-120));
          }
          done = Boolean(json.done);
        }
        setMessage(`${type === "discover" ? "发现" : "轮询"}完成`);
        await refreshLists();
        await fetchStatus();
      } catch (e) {
        setMessage(e instanceof Error ? e.message : "驱动失败");
      } finally {
        driving.current = false;
        setBusy(false);
      }
    },
    [fetchStatus, refreshLists]
  );

  const maybeStartPoll = useCallback(
    async (s: Status) => {
      if (s.running || driving.current) return;
      if (!s.tradingSession) return;
      const last = s.lastPollAt ? new Date(s.lastPollAt).getTime() : 0;
      if (Date.now() - last < POLL_INTERVAL_MS) return;
      const res = await fetch("/api/poll", { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        if (res.status !== 409) setMessage(json.error ?? "轮询启动失败");
        return;
      }
      if (json.skipped) {
        setMessage(json.reason ?? "已跳过轮询");
        return;
      }
      await driveSteps("poll", json.runId);
    },
    [driveSteps]
  );

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    (async () => {
      try {
        await refreshLists();
        const s = await fetchStatus();
        if (s.running) {
          const phase = s.running.progress?.phase ?? "";
          setProgress({
            processed: s.running.progress?.processed ?? 0,
            total: s.running.progress?.total ?? 0,
            phase,
            label: PHASE_LABEL[phase] ?? s.running.type,
          });
          setLog([
            {
              level: "info",
              text: `继续未完成的${s.running.type === "discover" ? "发现" : "轮询"}`,
            },
          ]);
          await driveSteps(s.running.type, s.running.id);
        } else {
          await maybeStartPoll(s);
        }
      } catch (e) {
        setMessage(e instanceof Error ? e.message : "初始化失败");
      }
    })();

    const timer = setInterval(async () => {
      try {
        const s = await fetchStatus();
        await maybeStartPoll(s);
      } catch {
        /* ignore */
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [driveSteps, fetchStatus, maybeStartPoll, refreshLists]);

  async function onDiscover() {
    if (busy) return;
    setLog([]);
    setProgress({ processed: 0, total: 0, label: "抓取快照", phase: "snapshot" });
    setMessage("开始发现，正在抓取全市场快照…");
    const res = await fetch("/api/discover", { method: "POST" });
    const json = await res.json();
    if (!res.ok) {
      setMessage(json.error ?? "发现启动失败");
      return;
    }
    await driveSteps("discover", json.runId);
  }

  async function onAddWatch() {
    const res = await fetch("/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: addCode }),
    });
    const json = await res.json();
    if (!res.ok) {
      setMessage(json.error ?? "添加失败");
      return;
    }
    setAddCode("");
    setMessage(`已添加 ${json.item.code}`);
    await refreshLists();
  }

  async function onDeleteWatch(id: string) {
    await fetch(`/api/watchlist?id=${id}`, { method: "DELETE" });
    await refreshLists();
  }

  async function onAddHolding() {
    const res = await fetch("/api/holdings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: holdCode, quantity: Number(holdQty) }),
    });
    const json = await res.json();
    if (!res.ok) {
      setMessage(json.error ?? "持仓录入失败");
      return;
    }
    setHoldCode("");
    setMessage(`已录入持仓 ${json.item.code}`);
    await refreshLists();
  }

  async function onDeleteHolding(id: string) {
    await fetch(`/api/holdings?id=${id}`, { method: "DELETE" });
    await refreshLists();
  }

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const pctBar =
    progress.total > 0
      ? Math.min(100, Math.round((progress.processed / progress.total) * 100))
      : busy
        ? 8
        : 0;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">A股 Jev 观察助手</h1>
        <p className="text-sm text-zinc-500">
          交易时段：{status?.tradingSession ? "是" : "否"}
          {" · "}
          上次轮询：{fmtTime(status?.lastPollAt)}
          {message ? ` · ${message}` : ""}
        </p>
      </header>

      <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-wrap items-end gap-3">
          <button
            type="button"
            onClick={onDiscover}
            disabled={busy}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {busy ? "运行中…" : "发现"}
          </button>
          <div className="min-w-[200px] flex-1">
            <div className="mb-1 flex justify-between text-xs text-zinc-500">
              <span>{progress.label || "进度"}</span>
              <span>
                {progress.processed}/{progress.total || "—"} ({pctBar}%)
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
              <div
                className={`h-full bg-emerald-500 transition-all ${busy && progress.total === 0 ? "animate-pulse" : ""}`}
                style={{ width: `${pctBar}%` }}
              />
            </div>
          </div>
          <div className="flex gap-2">
            <input
              value={addCode}
              onChange={(e) => setAddCode(e.target.value)}
              placeholder="6位代码"
              maxLength={6}
              className="w-28 rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <button
              type="button"
              onClick={onAddWatch}
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700"
            >
              加入观察池
            </button>
          </div>
        </div>
        {(busy || log.length > 0) && (
          <div
            ref={logRef}
            className="mt-3 max-h-48 overflow-y-auto rounded-lg bg-zinc-50 px-3 py-2 font-mono text-xs leading-5 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300"
          >
            {log.length === 0 ? (
              <div className="text-zinc-400">等待本步返回…</div>
            ) : (
              log.map((line, i) => (
                <div
                  key={`${i}-${line.text}`}
                  className={
                    line.level === "fail"
                      ? "text-red-600"
                      : line.level === "ok"
                        ? "text-emerald-700 dark:text-emerald-400"
                        : ""
                  }
                >
                  {line.text}
                </div>
              ))
            )}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="mb-3 text-lg font-medium">观察池</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b text-zinc-500">
              <tr>
                <th className="py-2 pr-2">代码</th>
                <th className="py-2 pr-2">名称</th>
                <th className="py-2 pr-2">来源</th>
                <th className="py-2 pr-2">AI分</th>
                <th className="py-2 pr-2">买入概率</th>
                <th className="py-2 pr-2">更新时间</th>
                <th className="py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {watchlist.map((row) => (
                <Fragment key={row.id}>
                  <tr className="border-b border-zinc-100 dark:border-zinc-800">
                    <td className="py-2 pr-2 font-mono">
                      <button
                        type="button"
                        className="text-left underline-offset-2 hover:underline"
                        onClick={() =>
                          setExpanded(expanded === row.id ? null : row.id)
                        }
                      >
                        {row.code}
                      </button>
                    </td>
                    <td className="py-2 pr-2">{row.name}</td>
                    <td className="py-2 pr-2">{row.source}</td>
                    <td className="py-2 pr-2">{row.score ?? "—"}</td>
                    <td className="py-2 pr-2">{pct(row.latestBuyProbability)}</td>
                    <td className="py-2 pr-2">{fmtTime(row.latestBuyAt)}</td>
                    <td className="py-2">
                      <button
                        type="button"
                        className="text-red-600"
                        onClick={() => onDeleteWatch(row.id)}
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                  {expanded === row.id && (
                    <tr className="bg-zinc-50 dark:bg-zinc-900/40">
                      <td colSpan={7} className="px-3 py-2 text-xs text-zinc-600">
                        {row.judgments.length === 0
                          ? "暂无判断历史"
                          : row.judgments.map((j) => (
                              <div key={j.id}>
                                [{j.kind}] {pct(j.probability)} · {fmtTime(j.created_at)}
                              </div>
                            ))}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {watchlist.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-zinc-400">
                    暂无观察池股票
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="mb-3 text-lg font-medium">持仓</h2>
        <div className="mb-4 flex flex-wrap gap-2">
          <input
            value={holdCode}
            onChange={(e) => setHoldCode(e.target.value)}
            placeholder="6位代码"
            maxLength={6}
            className="w-28 rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <input
            value={holdQty}
            onChange={(e) => setHoldQty(e.target.value)}
            placeholder="数量"
            className="w-24 rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            type="button"
            onClick={onAddHolding}
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700"
          >
            录入持仓
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b text-zinc-500">
              <tr>
                <th className="py-2 pr-2">代码</th>
                <th className="py-2 pr-2">名称</th>
                <th className="py-2 pr-2">数量</th>
                <th className="py-2 pr-2">卖出概率</th>
                <th className="py-2 pr-2">更新时间</th>
                <th className="py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {holdings.map((row) => (
                <tr key={row.id} className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-2 font-mono">{row.code}</td>
                  <td className="py-2 pr-2">{row.name}</td>
                  <td className="py-2 pr-2">{row.quantity}</td>
                  <td className="py-2 pr-2">{pct(row.latestSellProbability)}</td>
                  <td className="py-2 pr-2">{fmtTime(row.latestSellAt)}</td>
                  <td className="py-2">
                    <button
                      type="button"
                      className="text-red-600"
                      onClick={() => onDeleteHolding(row.id)}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
              {holdings.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-zinc-400">
                    暂无持仓
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
