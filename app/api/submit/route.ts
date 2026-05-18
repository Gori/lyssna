import { put } from "@vercel/blob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";

// Hands the uploaded blob's URL to ElevenLabs and returns immediately with a
// transcription_id (webhook=true). The audio never passes through this
// function, and the call returns in well under any Vercel timeout.
export async function POST(request: Request) {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) {
    return Response.json(
      {
        error:
          "Server has no ELEVENLABS_API_KEY. Set it in Vercel → Settings → Environment Variables (Production) and redeploy.",
      },
      { status: 500 },
    );
  }

  let blobUrl: string;
  let filename: string;
  let numSpeakers: unknown;
  try {
    const b = await request.json();
    blobUrl = String(b.blobUrl ?? "");
    filename = String(b.filename ?? "transcript");
    numSpeakers = b.numSpeakers;
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  if (!/^https:\/\/[^\s]+$/.test(blobUrl)) {
    return Response.json({ error: "Missing uploaded file." }, { status: 400 });
  }

  const form = new FormData();
  form.set("cloud_storage_url", blobUrl);
  form.set("model_id", "scribe_v2");
  form.set("diarize", "true");
  form.set("timestamps_granularity", "word");
  form.set("tag_audio_events", "true");
  form.set("no_verbatim", "true");
  form.set("webhook", "true");
  const ns = Number.parseInt(String(numSpeakers ?? ""), 10);
  if (Number.isInteger(ns) && ns >= 1 && ns <= 32) {
    form.set("num_speakers", String(ns));
  }

  let res: Response;
  try {
    res = await fetch(STT_URL, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
    });
  } catch (err) {
    console.error("[submit] fetch threw:", err);
    return Response.json(
      { error: "Could not reach ElevenLabs." },
      { status: 502 },
    );
  }

  if (!res.ok) {
    let detail = `ElevenLabs returned ${res.status}.`;
    try {
      const e = await res.json();
      const d = e?.detail;
      if (typeof d === "string") detail = d;
      else if (d?.message) detail = d.message;
      else if (Array.isArray(d) && d[0]?.msg) detail = d[0].msg;
    } catch {
      /* keep generic */
    }
    console.error("[submit] not ok:", res.status, detail);
    if (res.status === 401) {
      detail = `ElevenLabs rejected the key (${detail}). The ELEVENLABS_API_KEY in Vercel is wrong/old/whitespace, or lacks Speech to Text permission. Fix it in Vercel env vars and redeploy.`;
    }
    return Response.json({ error: detail }, { status: res.status });
  }

  const data = (await res.json()) as { transcription_id?: string | null };
  const id = data.transcription_id;
  if (!id) {
    return Response.json(
      { error: "ElevenLabs did not return a transcription id." },
      { status: 502 },
    );
  }

  // Persist the mapping so the webhook knows which audio to delete and what to
  // name the transcript. Written before responding so it always precedes the
  // (minutes-later) webhook callback.
  await put(
    `jobs/${id}.json`,
    JSON.stringify({ blobUrl, filename }),
    {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
      allowOverwrite: true,
    },
  );

  return Response.json({ transcriptionId: id });
}
