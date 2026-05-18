import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { put, del, head } from "@vercel/blob";
import { toMarkdown, LANGUAGE_NAMES, type ScribeResponse } from "@/lib/markdown";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const TRANSCRIPT_URL = (id: string) =>
  `https://api.elevenlabs.io/v1/speech-to-text/transcripts/${id}`;

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

type Job = { blobUrl?: string; filename: string; transcriptionId?: string };

async function loadJob(jobId: string): Promise<Job | null> {
  try {
    const meta = await head(`jobs/${jobId}.json`);
    const res = await fetch(meta.url, { cache: "no-store" });
    const j = (await res.json()) as Job;
    return {
      blobUrl: j.blobUrl,
      transcriptionId: j.transcriptionId,
      filename: j.filename || "transcript",
    };
  } catch {
    return null;
  }
}

async function writeResult(jobId: string, payload: unknown) {
  await put(`results/${jobId}.json`, JSON.stringify(payload), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json",
    allowOverwrite: true,
  }).catch((e) => console.error("[webhook] writeResult failed:", e));
}

export async function POST(request: Request) {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET?.trim();
  if (!apiKey || !secret) {
    console.error("[webhook] missing ELEVENLABS_API_KEY or _WEBHOOK_SECRET");
    return new Response("server not configured", { status: 500 });
  }

  const raw = await request.text();
  const sig = request.headers.get("elevenlabs-signature") ?? "";
  console.log("[webhook] received bytes=", raw.length, "hasSig=", !!sig);

  try {
    const client = new ElevenLabsClient({ apiKey });
    await client.webhooks.constructEvent(raw, sig, secret);
  } catch (err) {
    console.error("[webhook] signature verification failed:", err);
    return new Response("invalid signature", { status: 401 });
  }

  // Find OUR jobId: every uuid in the verified body is a candidate; the one
  // with a matching jobs/ blob is ours. Shape-independent on purpose.
  const candidates = [...new Set(raw.match(UUID_RE) ?? [])].map((s) =>
    s.toLowerCase(),
  );
  let jobId: string | null = null;
  let job: Job | null = null;
  for (const c of candidates) {
    const j = await loadJob(c);
    if (j) {
      jobId = c;
      job = j;
      break;
    }
  }

  if (!jobId || !job) {
    console.error(
      "[webhook] no matching job. uuids=",
      candidates,
      "bodyHead=",
      raw.slice(0, 400),
    );
    return new Response("ok", { status: 200 }); // ack; nothing we can map
  }

  try {
    const tid = job.transcriptionId;
    if (!tid) throw new Error("job missing transcriptionId");
    const res = await fetch(TRANSCRIPT_URL(tid), {
      headers: { "xi-api-key": apiKey },
    });
    if (!res.ok) throw new Error(`get-transcript ${res.status}`);
    const data = (await res.json()) as ScribeResponse;
    const durationSecs = data.audio_duration_secs ?? 0;
    const { markdown, speakerCount, wordCount } = toMarkdown(
      data,
      job.filename,
      durationSecs,
    );
    const langCode = (data.language_code ?? "").toLowerCase();
    await writeResult(jobId, {
      status: "done",
      filename: `${job.filename.replace(/\.[^/.]+$/, "") || "transcript"}.md`,
      markdown,
      meta: {
        durationSecs,
        language: LANGUAGE_NAMES[langCode] ?? langCode ?? "auto",
        languageCode: langCode,
        languageProbability: data.language_probability ?? null,
        speakerCount,
        wordCount,
      },
    });
    console.log("[webhook] stored result for job", jobId);
  } catch (err) {
    console.error("[webhook] processing failed for", jobId, err);
    await writeResult(jobId, {
      status: "error",
      error: "Transcription completed but could not be processed.",
    });
  }

  if (job.blobUrl) await del(job.blobUrl).catch(() => {});
  return new Response("ok", { status: 200 });
}
