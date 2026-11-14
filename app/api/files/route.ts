import { mailEnabled } from "@/lib/mail";
import { createFile, deleteFile, deleteOwner, listFiles, newOwnerKey, setOwnerEmail, updateFile, validOwner } from "@/lib/files";

export const runtime = "nodejs";

/** GET ?owner=KEY -> the owner's saved files, soonest deadline first. */
export async function GET(req: Request) {
  const owner = new URL(req.url).searchParams.get("owner");
  if (!validOwner(owner)) return Response.json({ error: "Invalid tracker key." }, { status: 400 });
  try {
    return Response.json({ files: await listFiles(owner), email_reminders: mailEnabled() }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("files list", e);
    return Response.json({ error: "Could not load the tracker." }, { status: 500 });
  }
}

/** POST { owner?, file } -> saves one file; creates a new owner key if none given. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { owner?: string; file?: Record<string, unknown> };
  const owner = validOwner(body.owner) ? body.owner : newOwnerKey();
  try {
    const file = await createFile(owner, body.file ?? {});
    return Response.json({ owner, file });
  } catch (e) {
    console.error("files create", e);
    return Response.json({ error: "Could not save this file." }, { status: 400 });
  }
}

/** PATCH { owner, id?, start_date?, email? } -> update one file, or the email on all files when no id. */
export async function PATCH(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { owner?: string; id?: string; start_date?: string; email?: string | null };
  if (!validOwner(body.owner)) return Response.json({ error: "Invalid tracker key." }, { status: 400 });
  try {
    if (body.id) await updateFile(body.owner, body.id, { start_date: body.start_date, email: body.email });
    else await setOwnerEmail(body.owner, body.email);
    return Response.json({ ok: true });
  } catch (e) {
    console.error("files update", e);
    return Response.json({ error: "Could not update." }, { status: 400 });
  }
}

/** DELETE ?owner=KEY[&id=ID] -> delete one file, or everything for this key. */
export async function DELETE(req: Request) {
  const q = new URL(req.url).searchParams;
  const owner = q.get("owner");
  if (!validOwner(owner)) return Response.json({ error: "Invalid tracker key." }, { status: 400 });
  const id = q.get("id");
  try {
    if (id) await deleteFile(owner, id);
    else await deleteOwner(owner);
    return Response.json({ ok: true });
  } catch (e) {
    console.error("files delete", e);
    return Response.json({ error: "Could not delete." }, { status: 500 });
  }
}
