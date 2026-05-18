import { head } from "@vercel/blob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The browser polls this until the webhook has written results/{id}.json.
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
    return Response.json({ error: "Bad id." }, { status: 400 });
  }

  let url: string;
  try {
    const meta = await head(`results/${id}.json`);
    url = meta.url;
  } catch {
    return Response.json({ status: "pending" });
  }

  try {
    const res = await fetch(url, { cache: "no-store" });
    const body = await res.json();
    return Response.json(body);
  } catch {
    return Response.json({ status: "pending" });
  }
}
