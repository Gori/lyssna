import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { put, del, head } from "@vercel/blob";
import { toMarkdown, LANGUAGE_NAMES, type ScribeResponse } from "@/lib/markdown";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

// The webhook delivers the full transcript inline. Find the ScribeResponse-ish
// object anywhere in the verified event rather than assuming its exact path.
function findTranscript(obj: unknown, depth = 0): ScribeResponse | null {
  if (!obj || typeof obj !== "object" || depth > 6) return null;
  const o = obj as Record<string, unknown>;
  if (Array.isArray(o.words) || typeof o.text === "string") {
    return o as ScribeResponse;
  }
  for (const v of Object.values(o)) {
    const found = findTranscript(v, depth + 1);
    if (found) return found;
  }
  return null;
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

  let event: unknown;
  try {
    const client = new ElevenLabsClient({ apiKey });
    event = await client.webhooks.constructEvent(raw, sig, secret);
    console.log("[webhook] signature verified");
  } catch (err) {
    console.error("[webhook] signature verification failed:", err);
    return new Response("invalid signature", { status: 401 });
  }

  // Our jobId is whatever uuid in the body maps to a jobs/ blob.
  const candidates = [...new Set(raw.match(UUID_RE) ?? [])].map((s) =>
    s.toLowerCase(),
  );
  console.log("[webhook] uuid candidates=", candidates.length);
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
    console.error("[webhook] no matching job. bodyHead=", raw.slice(0, 300));
    return new Response("ok", { status: 200 });
  }
  console.log("[webhook] matched job", jobId);

  try {
    // Prefer the transcript already in the webhook; only fetch as a fallback.
    let data = findTranscript(event) ?? findTranscript(JSON.parse(raw));
    if (data) {
      console.log("[webhook] using inline transcript");
    } else if (job.transcriptionId) {
      console.log("[webhook] fetching transcript", job.transcriptionId);
      const res = await fetch(TRANSCRIPT_URL(job.transcriptionId), {
        headers: { "xi-api-key": apiKey },
      });
      if (!res.ok) throw new Error(`get-transcript ${res.status}`);
      data = (await res.json()) as ScribeResponse;
    } else {
      throw new Error("no transcript in payload and no transcriptionId");
    }

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
    console.log("[webhook] stored result for", jobId);
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
