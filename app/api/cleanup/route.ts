import { list, del } from "@vercel/blob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Daily Vercel cron (see vercel.json). Deletes recordings and bookkeeping
// blobs older than 24h — the guaranteed cleanup sweep.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PREFIXES = ["uploads/", "jobs/", "results/"];

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return new Response("unauthorized", { status: 401 });
    }
  }

  const cutoff = Date.now() - MAX_AGE_MS;
  let deleted = 0;

  for (const prefix of PREFIXES) {
    let cursor: string | undefined;
    do {
      const { blobs, cursor: next, hasMore } = await list({ prefix, cursor });
      const stale = blobs
        .filter((b) => b.uploadedAt.getTime() < cutoff)
        .map((b) => b.url);
      if (stale.length) {
        await del(stale);
        deleted += stale.length;
      }
      cursor = hasMore ? next : undefined;
    } while (cursor);
  }

  return Response.json({ deleted });
}
