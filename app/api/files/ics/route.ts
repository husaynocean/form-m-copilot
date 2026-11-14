import { listFiles, toIcs, validOwner } from "@/lib/files";

export const runtime = "nodejs";

/** GET ?owner=KEY&id=ID -> calendar file with reminders 30, 7 and 1 day before the deadline. */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const owner = u.searchParams.get("owner");
  const id = u.searchParams.get("id");
  if (!validOwner(owner) || !id) return new Response("Invalid link", { status: 400 });
  const file = (await listFiles(owner)).find((f) => f.id === id);
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(toIcs(file, u.origin), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${file.deadline_title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.ics"`,
      "Cache-Control": "no-store",
    },
  });
}
