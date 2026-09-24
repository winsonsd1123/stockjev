"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type WatchItem = {
  id: number;
  market: string;
  code: string;
  name: string;
  source: "ai" | "manual";
  score: number | null;
  entryPrice: number | null;
  lastPrice: number | null;
  latestBuyProbability: number | null;
  latestBuyAt: string | null;
};

type HoldingItem = {
  id: number;
  market: string;
  code: string;
  name: string;
  quantity: number;
  entryPrice: number | null;
  lastPrice: number | null;
  latestSellProbability: number | null;
  latestSellAt: string | null;
};

type Suggestion = {
  market: string;
  code: string;
  name: string;
  score: number;
};

type Status = {
  running: {
    id: number;
    type: "discover" | "poll";
    progress: {
      processed?: number;
      total?: number;
      phase?: string;
      scored?: number;
      suggestions?: Suggestion[];
    };
  } | null;
  lastPollAt: string | null;
  tradingDay: boolean;
  tradingSession: boolean;
  suggestions?: Suggestion[];
};

type StepEvent = { level: "info" | "ok" | "fail"; text: string };

type RunProgress = {
  processed: number;
  total: number;
  label: string;
  phase: string;
};

type Toast = {
  id: number;
  kind: "ok" | "fail";
  text: string;
};

type ListsStatus = "loading" | "ready";

const POLL_INTERVAL_MS = 15 * 60 * 1000;
const HIGHLIGHT_MS = 1600;

const PHASE_LABEL: Record<string, string> = {
  scan: "发现扫描",
  snapshot: "抓取快照",
  score: "优秀度打分",
  commit: "生成建议",
  context: "抓取大盘",
  items: "盘中判定",
  done: "已完成",
};

function pct(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function money(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return v.toFixed(2);
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

function validateCode(raw: string): string | null {
  const code = raw.trim();
  if (!/^\d{6}$/.test(code)) return "请输入 6 位数字代码";
  return null;
}

function validateQty(raw: string): string | null {
  if (!/^\d+$/.test(raw.trim()) || Number(raw) <= 0) {
    return "数量须为正整数";
  }
  return null;
}

function barPct(processed: number, total: number, pulsing: boolean): number {
  if (total > 0) return Math.min(100, Math.round((processed / total) * 100));
  return pulsing ? 8 : 0;
}

function SkeletonRows({ cols, rows = 4 }: { cols: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <tr key={`sk-${i}`} className="border-b border-zinc-100 dark:border-zinc-800">
          {Array.from({ length: cols }, (_, j) => (
            <td key={j} className="py-3 pr-2">
              <div className="h-3 w-16 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export default function HomePage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [watchlist, setWatchlist] = useState<WatchItem[]>([]);
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [listsStatus, setListsStatus] = useState<ListsStatus>("loading");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [discoverProgress, setDiscoverProgress] = useState<RunProgress>({
    processed: 0,
    total: 0,
    label: "",
    phase: "",
  });
  const [pollProgress, setPollProgress] = useState<RunProgress>({
    processed: 0,
    total: 0,
    label: "",
    phase: "",
  });
  const [discoverLog, setDiscoverLog] = useState<StepEvent[]>([]);
  const [pollLog, setPollLog] = useState<StepEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [busyType, setBusyType] = useState<"discover" | "poll" | null>(null);
  const [taskMessage, setTaskMessage] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  const [addCode, setAddCode] = useState("");
  const [addCodeError, setAddCodeError] = useState("");
  const [holdCode, setHoldCode] = useState("");
  const [holdQty, setHoldQty] = useState("100");
  const [holdError, setHoldError] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [confirmDiscover, setConfirmDiscover] = useState(false);
  const [confirmWatchId, setConfirmWatchId] = useState<number | null>(null);
  const [confirmHoldId, setConfirmHoldId] = useState<number | null>(null);
  const [addedSuggestionKeys, setAddedSuggestionKeys] = useState<Set<string>>(
    () => new Set()
  );
  const [highlightWatchIds, setHighlightWatchIds] = useState<Set<number>>(
    () => new Set()
  );
  const [highlightHoldIds, setHighlightHoldIds] = useState<Set<number>>(
    () => new Set()
  );
  const [activeTab, setActiveTab] = useState<"watch" | "discover">("watch");
  const [discoverLogOpen, setDiscoverLogOpen] = useState(false);
  const [pollLogOpen, setPollLogOpen] = useState(false);
  const discoverLogUserClosed = useRef(false);
  const pollLogUserClosed = useRef(false);

  const driving = useRef(false);
  const bootstrapped = useRef(false);
  const listsReady = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchPrev = useRef<
    Map<number, { p: number | null; at: string | null; price: number | null }>
  >(new Map());
  const holdPrev = useRef<
    Map<number, { p: number | null; at: string | null; price: number | null }>
  >(new Map());
  const discoverLogRef = useRef<HTMLDivElement>(null);
  const pollLogRef = useRef<HTMLDivElement>(null);

  const showToast = useCallback((kind: "ok" | "fail", text: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    const id = Date.now();
    setToast({ id, kind, text });
    toastTimer.current = setTimeout(
      () => setToast((t) => (t?.id === id ? null : t)),
      kind === "fail" ? 4000 : 2500
    );
  }, []);

  const applyWatchlist = useCallback(
    (items: WatchItem[], highlight = false) => {
      if (highlight) {
        const changed = new Set<number>();
        for (const row of items) {
          const prev = watchPrev.current.get(row.id);
          if (
            prev &&
            (prev.p !== row.latestBuyProbability ||
              prev.at !== row.latestBuyAt ||
              prev.price !== row.lastPrice)
          ) {
            changed.add(row.id);
          }
        }
        if (changed.size > 0) {
          setHighlightWatchIds(changed);
          setTimeout(() => setHighlightWatchIds(new Set()), HIGHLIGHT_MS);
        }
      }
      watchPrev.current = new Map(
        items.map((r) => [
          r.id,
          { p: r.latestBuyProbability, at: r.latestBuyAt, price: r.lastPrice },
        ])
      );
      setWatchlist(items);
    },
    []
  );

  const applyHoldings = useCallback(
    (items: HoldingItem[], highlight = false) => {
      if (highlight) {
        const changed = new Set<number>();
        for (const row of items) {
          const prev = holdPrev.current.get(row.id);
          if (
            prev &&
            (prev.p !== row.latestSellProbability ||
              prev.at !== row.latestSellAt ||
              prev.price !== row.lastPrice)
          ) {
            changed.add(row.id);
          }
        }
        if (changed.size > 0) {
          setHighlightHoldIds(changed);
          setTimeout(() => setHighlightHoldIds(new Set()), HIGHLIGHT_MS);
        }
      }
      holdPrev.current = new Map(
        items.map((r) => [
          r.id,
          {
            p: r.latestSellProbability,
            at: r.latestSellAt,
            price: r.lastPrice,
          },
        ])
      );
      setHoldings(items);
    },
    []
  );

  const refreshLists = useCallback(
    async (opts?: { highlight?: boolean }) => {
      const [w, h] = await Promise.all([
        fetch("/api/watchlist").then((r) => r.json()),
        fetch("/api/holdings").then((r) => r.json()),
      ]);
      if (w.items) applyWatchlist(w.items, Boolean(opts?.highlight));
      if (h.items) applyHoldings(h.items, Boolean(opts?.highlight));
      if (!listsReady.current) {
        listsReady.current = true;
        setListsStatus("ready");
      }
    },
    [applyHoldings, applyWatchlist]
  );

  const fetchStatus = useCallback(async () => {
    const s = (await fetch("/api/status").then((r) => r.json())) as Status;
    setStatus(s);
    if (s.suggestions) setSuggestions(s.suggestions as Suggestion[]);
    return s;
  }, []);

  const driveSteps = useCallback(
    async (type: "discover" | "poll", runId?: number) => {
      if (driving.current) return;
      driving.current = true;
      setBusy(true);
      setBusyType(type);
      try {
        let done = false;
        let currentRunId = runId;
        while (!done) {
          setTaskMessage(
            type === "discover" ? "正在推进发现…" : "正在推进盘中判定…"
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
          const next: RunProgress = {
            processed: json.processed ?? 0,
            total: json.total ?? 0,
            phase,
            label: PHASE_LABEL[phase] ?? phase,
          };
          if (type === "discover") setDiscoverProgress(next);
          else setPollProgress(next);
          if (json.message) setTaskMessage(json.message);
          if (Array.isArray(json.events) && json.events.length > 0) {
            if (type === "discover") {
              setDiscoverLog((prev) => [...prev, ...json.events].slice(-200));
            } else {
              setPollLog((prev) => [...prev, ...json.events].slice(-200));
            }
          }
          if (json.suggestions) setSuggestions(json.suggestions);
          if (type === "poll") {
            await refreshLists({ highlight: true });
          }
          done = Boolean(json.done);
        }
        if (type === "discover") {
          setTaskMessage("发现完成");
          showToast("ok", "建议已生成");
        } else {
          setTaskMessage("盘中判定完成");
          showToast("ok", "盘中判定完成");
        }
        await refreshLists({ highlight: type === "poll" });
        await fetchStatus();
      } catch (e) {
        const msg = e instanceof Error ? e.message : "驱动失败";
        setTaskMessage(msg);
        showToast("fail", msg);
      } finally {
        driving.current = false;
        setBusy(false);
        setBusyType(null);
      }
    },
    [fetchStatus, refreshLists, showToast]
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
        if (res.status !== 409) {
          const msg = json.error ?? "轮询启动失败";
          setTaskMessage(msg);
          showToast("fail", msg);
        }
        return;
      }
      if (json.skipped) {
        setTaskMessage(json.reason ?? "已跳过轮询");
        return;
      }
      setPollLog((prev) => [
        ...prev,
        {
          level: "info",
          text: `开始盘中判定 ${new Date().toLocaleTimeString("zh-CN")}`,
        },
      ]);
      setPollProgress({
        processed: 0,
        total: 0,
        label: "盘中判定",
        phase: "context",
      });
      await driveSteps("poll", json.runId);
    },
    [driveSteps, showToast]
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
          const next: RunProgress = {
            processed:
              s.running.progress?.processed ??
              s.running.progress?.scored ??
              0,
            total: s.running.progress?.total ?? 0,
            phase,
            label: PHASE_LABEL[phase] ?? s.running.type,
          };
          if (s.running.type === "discover") {
            setDiscoverProgress(next);
            setDiscoverLog([{ level: "info", text: "继续未完成的发现" }]);
          } else {
            setPollProgress(next);
            setPollLog([{ level: "info", text: "继续未完成的盘中判定" }]);
          }
          await driveSteps(s.running.type, s.running.id);
        } else {
          await maybeStartPoll(s);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "初始化失败";
        setTaskMessage(msg);
        showToast("fail", msg);
        setListsStatus("ready");
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

    return () => {
      clearInterval(timer);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [driveSteps, fetchStatus, maybeStartPoll, refreshLists, showToast]);

  useEffect(() => {
    discoverLogRef.current?.scrollTo({
      top: discoverLogRef.current.scrollHeight,
    });
  }, [discoverLog]);

  useEffect(() => {
    pollLogRef.current?.scrollTo({ top: pollLogRef.current.scrollHeight });
  }, [pollLog]);

  useEffect(() => {
    if (busy && busyType === "discover" && !discoverLogUserClosed.current) {
      setDiscoverLogOpen(true);
    }
    if (!(busy && busyType === "discover")) {
      discoverLogUserClosed.current = false;
    }
  }, [busy, busyType]);

  useEffect(() => {
    if (busy && busyType === "poll" && !pollLogUserClosed.current) {
      setPollLogOpen(true);
    }
    if (!(busy && busyType === "poll")) {
      pollLogUserClosed.current = false;
    }
  }, [busy, busyType]);

  async function startDiscover() {
    setConfirmDiscover(false);
    if (busy) return;
    setDiscoverLog([]);
    setDiscoverProgress({
      processed: 0,
      total: 0,
      label: "发现扫描",
      phase: "scan",
    });
    setTaskMessage("开始发现…");
    const res = await fetch("/api/discover", { method: "POST" });
    const json = await res.json();
    if (!res.ok) {
      const msg = json.error ?? "发现启动失败";
      setTaskMessage(msg);
      showToast("fail", msg);
      return;
    }
    await driveSteps("discover", json.runId);
  }

  async function onAddWatch(codeRaw?: string, score?: number) {
    const raw = codeRaw ?? addCode;
    const err = validateCode(raw);
    if (err) {
      if (codeRaw == null) setAddCodeError(err);
      else showToast("fail", err);
      return;
    }
    const code = raw.trim();
    const key = codeRaw != null ? `s:${code}` : "manual";
    if (pendingAction) return;
    setPendingAction(key);
    if (codeRaw == null) setAddCodeError("");
    try {
      const res = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, score: score ?? null }),
      });
      const json = await res.json();
      if (!res.ok) {
        showToast("fail", json.error ?? "添加失败");
        return;
      }
      if (codeRaw == null) setAddCode("");
      else {
        setAddedSuggestionKeys((prev) => new Set(prev).add(`${json.item.market}:${json.item.code}`));
      }
      showToast("ok", `已加入观察池 ${json.item.code} ${json.item.name ?? ""}`.trim());
      await refreshLists();
    } catch (e) {
      showToast("fail", e instanceof Error ? e.message : "添加失败");
    } finally {
      setPendingAction(null);
    }
  }

  async function onDeleteWatch(id: number) {
    const key = `del-w:${id}`;
    if (pendingAction) return;
    setPendingAction(key);
    try {
      const res = await fetch(`/api/watchlist?id=${id}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast("fail", json.error ?? "删除失败");
        return;
      }
      setConfirmWatchId(null);
      showToast("ok", "已从观察池删除");
      await refreshLists();
    } catch (e) {
      showToast("fail", e instanceof Error ? e.message : "删除失败");
    } finally {
      setPendingAction(null);
    }
  }

  async function onAddHolding() {
    const codeErr = validateCode(holdCode);
    const qtyErr = validateQty(holdQty);
    if (codeErr || qtyErr) {
      setHoldError(codeErr ?? qtyErr ?? "");
      return;
    }
    if (pendingAction) return;
    setPendingAction("hold");
    setHoldError("");
    try {
      const res = await fetch("/api/holdings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: holdCode.trim(),
          quantity: Number(holdQty),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        showToast("fail", json.error ?? "持仓录入失败");
        return;
      }
      setHoldCode("");
      showToast(
        "ok",
        `已录入持仓 ${json.item.code} ${json.item.name ?? ""}`.trim()
      );
      await refreshLists();
    } catch (e) {
      showToast("fail", e instanceof Error ? e.message : "持仓录入失败");
    } finally {
      setPendingAction(null);
    }
  }

  async function onDeleteHolding(id: number) {
    const key = `del-h:${id}`;
    if (pendingAction) return;
    setPendingAction(key);
    try {
      const res = await fetch(`/api/holdings?id=${id}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast("fail", json.error ?? "删除失败");
        return;
      }
      setConfirmHoldId(null);
      showToast("ok", "已删除持仓");
      await refreshLists();
    } catch (e) {
      showToast("fail", e instanceof Error ? e.message : "删除失败");
    } finally {
      setPendingAction(null);
    }
  }

  const discoverBusy = busy && busyType === "discover";
  const pollBusy = busy && busyType === "poll";
  const discoverBar = barPct(
    discoverProgress.processed,
    discoverProgress.total,
    discoverBusy && discoverProgress.total === 0
  );
  const pollBar = barPct(
    pollProgress.processed,
    pollProgress.total,
    pollBusy && pollProgress.total === 0
  );
  const rowHighlight =
    "bg-emerald-50 transition-colors duration-500 dark:bg-emerald-950/40";

  const crossBanner =
    activeTab === "watch" && discoverBusy
      ? {
          tab: "discover" as const,
          text: `发现中 ${discoverProgress.processed}/${discoverProgress.total || "—"} · ${discoverProgress.label || taskMessage || "进行中"}`,
        }
      : activeTab === "discover" && pollBusy
        ? {
            tab: "watch" as const,
            text: `盘中判定 ${pollProgress.processed}/${pollProgress.total || "—"} · ${pollProgress.label || taskMessage || "进行中"}`,
          }
        : null;

  const tabBtn = (id: "watch" | "discover", label: string, running: boolean, dot: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={activeTab === id}
      onClick={() => setActiveTab(id)}
      className={`inline-flex items-center px-4 py-2.5 text-sm ${
        activeTab === id
          ? "border-b-2 border-zinc-900 font-medium text-zinc-900 dark:border-zinc-100 dark:text-zinc-100"
          : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
      }`}
    >
      {label}
      {running ? (
        <span
          className={`ml-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full ${dot}`}
          aria-label="任务进行中"
        />
      ) : null}
    </button>
  );

  const logToggle = (
    open: boolean,
    count: number,
    onToggle: (next: boolean) => void,
    markClosed: () => void
  ) => (
    <button
      type="button"
      className="mt-2 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
      onClick={() => {
        const next = !open;
        if (!next) markClosed();
        onToggle(next);
      }}
    >
      {open ? "▼" : "▶"} 日志（{count}）
    </button>
  );

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      {toast && (
        <div
          role={toast.kind === "fail" ? "alert" : "status"}
          className={`fixed right-4 top-4 z-50 flex max-w-sm items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg ${
            toast.kind === "ok"
              ? "border-emerald-200 bg-white text-emerald-800 dark:border-emerald-800 dark:bg-zinc-950 dark:text-emerald-300"
              : "border-red-200 bg-white text-red-700 dark:border-red-900 dark:bg-zinc-950 dark:text-red-300"
          }`}
        >
          <span className="flex-1">{toast.text}</span>
          <button
            type="button"
            className="text-zinc-400 hover:text-zinc-600"
            onClick={() => setToast(null)}
            aria-label="关闭"
          >
            ×
          </button>
        </div>
      )}

      <header className="sticky top-0 z-40 -mx-4 space-y-2 border-b border-zinc-200 bg-zinc-50/95 px-4 py-3 backdrop-blur dark:border-zinc-800 dark:bg-black/95">
        <div className="mx-auto max-w-6xl">
          <h1 className="text-2xl font-semibold tracking-tight">
            A股 Jev 观察助手
          </h1>
          <p className="text-sm text-zinc-500">
            交易时段：{status?.tradingSession ? "是" : "否"}
            {" · "}
            上次轮询：{fmtTime(status?.lastPollAt)}
            {taskMessage && !crossBanner ? ` · ${taskMessage}` : ""}
          </p>
          {crossBanner ? (
            <button
              type="button"
              onClick={() => setActiveTab(crossBanner.tab)}
              className="mt-2 w-full rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-left text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
            >
              {crossBanner.text} · 点击查看
            </button>
          ) : null}
          <div
            role="tablist"
            className="-mb-px mt-3 flex gap-1 border-b border-zinc-200 dark:border-zinc-800"
          >
            {tabBtn("watch", "观察", pollBusy, "bg-sky-500")}
            {tabBtn("discover", "发现", discoverBusy, "bg-emerald-500")}
          </div>
        </div>
      </header>

      {activeTab === "watch" && (
        <div role="tabpanel" className="flex flex-col gap-4">
          <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <h2 className="mb-1 text-lg font-medium">盘中判定</h2>
            <p className="mb-2 text-xs text-zinc-500">
              交易日 9:30–15:00，页面打开时每 15 分钟自动判定观察池买入 / 持仓卖出
              {pollBusy && taskMessage ? ` · ${taskMessage}` : ""}
            </p>
            {(pollBusy ||
              pollProgress.total > 0 ||
              pollProgress.processed > 0) && (
              <div className="mb-2">
                <div className="mb-1 flex justify-between text-xs text-zinc-500">
                  <span>{pollProgress.label || "盘中判定"}</span>
                  <span>
                    {pollProgress.processed}/{pollProgress.total || "—"} (
                    {pollBar}%)
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                  <div
                    className={`h-full bg-sky-500 transition-all ${
                      pollBusy && pollProgress.total === 0
                        ? "animate-pulse"
                        : ""
                    }`}
                    style={{
                      width: `${pollBusy || pollProgress.total > 0 ? pollBar : 0}%`,
                    }}
                  />
                </div>
              </div>
            )}
            {(pollBusy || pollLog.length > 0) &&
              logToggle(pollLogOpen, pollLog.length, setPollLogOpen, () => {
                pollLogUserClosed.current = true;
              })}
            {pollLogOpen && (pollBusy || pollLog.length > 0) && (
              <div
                ref={pollLogRef}
                className="mt-2 max-h-28 overflow-y-auto rounded-lg bg-zinc-50 px-3 py-2 font-mono text-xs leading-5 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300"
              >
                {pollLog.length === 0 ? (
                  <div className="text-zinc-400">等待盘中判定本步返回…</div>
                ) : (
                  pollLog.map((line, i) => (
                    <div
                      key={`p-${i}-${line.text}`}
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
                    <th className="py-2 pr-2">入池价</th>
                    <th className="py-2 pr-2">现价</th>
                    <th className="py-2 pr-2">AI分</th>
                    <th className="py-2 pr-2">买入概率</th>
                    <th className="py-2 pr-2">更新时间</th>
                    <th className="py-2">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {listsStatus === "loading" && <SkeletonRows cols={8} />}
                  {listsStatus === "ready" &&
                    watchlist.map((row) => (
                      <tr
                        key={row.id}
                        className={`border-b border-zinc-100 dark:border-zinc-800 ${
                          highlightWatchIds.has(row.id) ? rowHighlight : ""
                        }`}
                      >
                        <td className="py-2 pr-2 font-mono">{row.code}</td>
                        <td className="py-2 pr-2">{row.name}</td>
                        <td className="py-2 pr-2">{money(row.entryPrice)}</td>
                        <td className="py-2 pr-2">{money(row.lastPrice)}</td>
                        <td className="py-2 pr-2">{row.score ?? "—"}</td>
                        <td className="py-2 pr-2">
                          {pct(row.latestBuyProbability)}
                        </td>
                        <td className="py-2 pr-2">
                          {fmtTime(row.latestBuyAt)}
                        </td>
                        <td className="py-2">
                          {confirmWatchId === row.id ? (
                            <span className="inline-flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                className="text-zinc-500"
                                disabled={pendingAction === `del-w:${row.id}`}
                                onClick={() => setConfirmWatchId(null)}
                                autoFocus
                              >
                                取消
                              </button>
                              <button
                                type="button"
                                className="text-red-600"
                                disabled={Boolean(pendingAction)}
                                onClick={() => void onDeleteWatch(row.id)}
                              >
                                {pendingAction === `del-w:${row.id}`
                                  ? "删除中…"
                                  : `确认删除 ${row.code}`}
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="text-red-600 disabled:opacity-50"
                              disabled={Boolean(pendingAction)}
                              onClick={() => {
                                setConfirmHoldId(null);
                                setConfirmWatchId(row.id);
                              }}
                            >
                              删除
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  {listsStatus === "ready" && watchlist.length === 0 && (
                    <tr>
                      <td
                        colSpan={8}
                        className="py-6 text-center text-zinc-400"
                      >
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
            <div className="mb-1 flex flex-wrap gap-2">
              <input
                value={holdCode}
                onChange={(e) => {
                  setHoldCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                  if (holdError) setHoldError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void onAddHolding();
                  }
                }}
                placeholder="6位代码"
                maxLength={6}
                inputMode="numeric"
                disabled={Boolean(pendingAction)}
                className="w-28 rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
              <input
                value={holdQty}
                onChange={(e) => {
                  setHoldQty(e.target.value.replace(/\D/g, ""));
                  if (holdError) setHoldError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void onAddHolding();
                  }
                }}
                placeholder="数量"
                inputMode="numeric"
                disabled={Boolean(pendingAction)}
                className="w-24 rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
              <button
                type="button"
                onClick={() => void onAddHolding()}
                disabled={Boolean(pendingAction) || busy}
                className="rounded-lg border border-zinc-300 px-3 py-2 text-sm disabled:opacity-50 dark:border-zinc-700"
              >
                {pendingAction === "hold" ? "录入中…" : "录入持仓"}
              </button>
            </div>
            {holdError ? (
              <p className="mb-3 text-xs text-red-600">{holdError}</p>
            ) : (
              <div className="mb-3" />
            )}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="border-b text-zinc-500">
                  <tr>
                    <th className="py-2 pr-2">代码</th>
                    <th className="py-2 pr-2">名称</th>
                    <th className="py-2 pr-2">数量</th>
                    <th className="py-2 pr-2">入池价</th>
                    <th className="py-2 pr-2">现价</th>
                    <th className="py-2 pr-2">卖出概率</th>
                    <th className="py-2 pr-2">更新时间</th>
                    <th className="py-2">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {listsStatus === "loading" && <SkeletonRows cols={8} />}
                  {listsStatus === "ready" &&
                    holdings.map((row) => (
                      <tr
                        key={row.id}
                        className={`border-b border-zinc-100 dark:border-zinc-800 ${
                          highlightHoldIds.has(row.id) ? rowHighlight : ""
                        }`}
                      >
                        <td className="py-2 pr-2 font-mono">{row.code}</td>
                        <td className="py-2 pr-2">{row.name}</td>
                        <td className="py-2 pr-2">{row.quantity}</td>
                        <td className="py-2 pr-2">{money(row.entryPrice)}</td>
                        <td className="py-2 pr-2">{money(row.lastPrice)}</td>
                        <td className="py-2 pr-2">
                          {pct(row.latestSellProbability)}
                        </td>
                        <td className="py-2 pr-2">
                          {fmtTime(row.latestSellAt)}
                        </td>
                        <td className="py-2">
                          {confirmHoldId === row.id ? (
                            <span className="inline-flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                className="text-zinc-500"
                                disabled={pendingAction === `del-h:${row.id}`}
                                onClick={() => setConfirmHoldId(null)}
                                autoFocus
                              >
                                取消
                              </button>
                              <button
                                type="button"
                                className="text-red-600"
                                disabled={Boolean(pendingAction)}
                                onClick={() => void onDeleteHolding(row.id)}
                              >
                                {pendingAction === `del-h:${row.id}`
                                  ? "删除中…"
                                  : `确认删除 ${row.code}`}
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="text-red-600 disabled:opacity-50"
                              disabled={Boolean(pendingAction)}
                              onClick={() => {
                                setConfirmWatchId(null);
                                setConfirmHoldId(row.id);
                              }}
                            >
                              删除
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  {listsStatus === "ready" && holdings.length === 0 && (
                    <tr>
                      <td
                        colSpan={8}
                        className="py-6 text-center text-zinc-400"
                      >
                        暂无持仓
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {activeTab === "discover" && (
        <div role="tabpanel" className="flex flex-col gap-4">
          <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex flex-wrap items-end gap-3">
              <button
                type="button"
                onClick={() => setConfirmDiscover(true)}
                disabled={busy}
                title={
                  pollBusy ? "盘中判定进行中，结束后可开始发现" : undefined
                }
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
              >
                {discoverBusy
                  ? "运行中…"
                  : pollBusy
                    ? "盘中判定中"
                    : "发现"}
              </button>
              <div className="min-w-[200px] flex-1">
                <div className="mb-1 flex justify-between text-xs text-zinc-500">
                  <span>
                    {discoverBusy
                      ? discoverProgress.label || "发现进度"
                      : "发现进度"}
                    {discoverBusy && taskMessage ? ` · ${taskMessage}` : ""}
                  </span>
                  <span>
                    {discoverProgress.processed}/
                    {discoverProgress.total || "—"} ({discoverBar}%)
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                  <div
                    className={`h-full bg-emerald-500 transition-all ${
                      discoverBusy && discoverProgress.total === 0
                        ? "animate-pulse"
                        : ""
                    }`}
                    style={{
                      width: `${discoverBusy || discoverProgress.total > 0 ? discoverBar : 0}%`,
                    }}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <div className="flex gap-2">
                  <input
                    value={addCode}
                    onChange={(e) => {
                      setAddCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                      if (addCodeError) setAddCodeError("");
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void onAddWatch();
                      }
                    }}
                    placeholder="6位代码"
                    maxLength={6}
                    inputMode="numeric"
                    disabled={Boolean(pendingAction)}
                    className="w-28 rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                  />
                  <button
                    type="button"
                    onClick={() => void onAddWatch()}
                    disabled={Boolean(pendingAction) || busy}
                    className="rounded-lg border border-zinc-300 px-3 py-2 text-sm disabled:opacity-50 dark:border-zinc-700"
                  >
                    {pendingAction === "manual" ? "加入中…" : "加入观察池"}
                  </button>
                </div>
                {addCodeError ? (
                  <p className="text-xs text-red-600">{addCodeError}</p>
                ) : null}
              </div>
            </div>

            {confirmDiscover && (
              <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm dark:border-amber-900 dark:bg-amber-950/40">
                <span className="flex-1 text-amber-900 dark:text-amber-200">
                  将抓取全市场并调用 Jev 打分，约数分钟，需保持页面打开。确认开始？
                </span>
                <button
                  type="button"
                  className="rounded-md px-3 py-1 text-zinc-600 hover:bg-white/60 dark:hover:bg-zinc-900"
                  onClick={() => setConfirmDiscover(false)}
                  autoFocus
                >
                  取消
                </button>
                <button
                  type="button"
                  className="rounded-md bg-zinc-900 px-3 py-1 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  onClick={() => void startDiscover()}
                >
                  确认开始
                </button>
              </div>
            )}

            {(discoverBusy || discoverLog.length > 0) &&
              logToggle(
                discoverLogOpen,
                discoverLog.length,
                setDiscoverLogOpen,
                () => {
                  discoverLogUserClosed.current = true;
                }
              )}
            {discoverLogOpen && (discoverBusy || discoverLog.length > 0) && (
              <div
                ref={discoverLogRef}
                className="mt-2 max-h-28 overflow-y-auto rounded-lg bg-zinc-50 px-3 py-2 font-mono text-xs leading-5 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300"
              >
                {discoverLog.length === 0 ? (
                  <div className="text-zinc-400">等待发现本步返回…</div>
                ) : (
                  discoverLog.map((line, i) => (
                    <div
                      key={`d-${i}-${line.text}`}
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

          {suggestions.length > 0 && (
            <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
              <h2 className="mb-3 text-lg font-medium">建议纳入</h2>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-left text-sm">
                  <thead className="border-b text-zinc-500">
                    <tr>
                      <th className="py-2 pr-2">#</th>
                      <th className="py-2 pr-2">代码</th>
                      <th className="py-2 pr-2">名称</th>
                      <th className="py-2 pr-2">AI分</th>
                      <th className="py-2">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {suggestions.map((s, i) => {
                      const sKey = `${s.market}:${s.code}`;
                      const pendingKey = `s:${s.code}`;
                      const added =
                        addedSuggestionKeys.has(sKey) ||
                        watchlist.some(
                          (w) => w.market === s.market && w.code === s.code
                        );
                      const pending = pendingAction === pendingKey;
                      return (
                        <tr
                          key={sKey}
                          className="border-b border-zinc-100 dark:border-zinc-800"
                        >
                          <td className="py-2 pr-2">{i + 1}</td>
                          <td className="py-2 pr-2 font-mono">{s.code}</td>
                          <td className="py-2 pr-2">{s.name}</td>
                          <td className="py-2 pr-2">{s.score}</td>
                          <td className="py-2">
                            {added ? (
                              <span className="text-zinc-400">已加入 ✓</span>
                            ) : (
                              <button
                                type="button"
                                className="text-emerald-700 disabled:opacity-50"
                                disabled={Boolean(pendingAction) || busy}
                                onClick={() => void onAddWatch(s.code, s.score)}
                              >
                                {pending ? "加入中…" : "加入观察池"}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}
    </main>
  );
}