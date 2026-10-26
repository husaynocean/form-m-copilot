import { NextResponse } from "next/server";
import { explainIssues, type Lang } from "@/lib/explain";
import type { Issue } from "@/lib/schema";

export const runtime = "nodejs";
export const maxDuration = 60;

/** POST { issues: Issue[], lang: "en" | "ha" | "pcm" } -> translated, number-verified fix-list. */
export async function POST(req: Request) {
  const { issues, lang } = (await req.json()) as { issues: Issue[]; lang: Lang };
  if (!Array.isArray(issues) || !["en", "ha", "pcm"].includes(lang)) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  try {
    return NextResponse.json({ items: await explainIssues(issues.slice(0, 20), lang) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
