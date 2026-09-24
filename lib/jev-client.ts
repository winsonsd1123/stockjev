import {
  JEV_MODEL,
  type DecisionsResponse,
} from "@/lib/jev";

const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

export type JevQuestionMap = Record<
  string,
  | {
      type: "noul";
      instructions: string;
      criteria: { true: string; false: string };
    }
  | {
      type: "score";
      instructions: string;
      criteria: string[];
    }
>;

async function callOnce(
  state: unknown,
  questions: JevQuestionMap
): Promise<DecisionsResponse> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("缺少 OPENROUTER_API_KEY");

  const res = await fetch(DECISIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/local/stock",
      "X-Title": "A-share Jev Observer",
    },
    body: JSON.stringify({
      model: JEV_MODEL,
      state,
      questions,
    }),
  });

  if (!res.ok) {
    throw new Error(`Jev 调用失败 ${res.status}`);
  }
  return (await res.json()) as DecisionsResponse;
}

/** Jev 调用，失败重试 1 次 */
export async function decide(
  state: unknown,
  questions: JevQuestionMap
): Promise<DecisionsResponse> {
  try {
    return await callOnce(state, questions);
  } catch {
    return await callOnce(state, questions);
  }
}
