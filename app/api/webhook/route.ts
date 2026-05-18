import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { put, del, head } from "@vercel/blob";
import { toMarkdown, LANGUAGE_NAMES, type ScribeResponse } from "@/lib/markdown";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const TRANSCRIPT_URL = (id: string) =>
  `https://api.elevenlabs.io/v1/speech-to-text/transcripts/${id}`;

function findId(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const direct = o.transcription_id ?? o.request_id ?? o.id;
  if (typeof direct === "string") return direct;
  if (o.data) return findId(o.data);
  return null;
}

async function readJob(
  id: string,
): Promise<{ blobUrl?: string; filename: string }> {
  try {
    const meta = await head(`jobs/${id}.json`);
    const res = await fetch(meta.url);
    const j = (await res.json()) as { blobUrl?: string; filename?: string };
    return { blobUrl: j.blobUrl, filename: j.filename || "transcript" };
  } catch {
    return { filename: "transcript" };
  }
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

  // Verify with ElevenLabs' own verifier — don't hand-roll the HMAC scheme.
  let event: unknown;
  try {
    const client = new ElevenLabsClient({ apiKey });
    event = await client.webhooks.constructEvent(raw, sig, secret);
  } catch (err) {
    console.error("[webhook] signature verification failed:", err);
    return new Response("invalid signature", { status: 401 });
  }

  let parsed: unknown = event;
  if (!findId(parsed)) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* keep event */
    }
  }
  const id = findId(event) ?? findId(parsed);
  if (!id) {
    console.error("[webhook] no transcription id in event");
    return new Response("ok", { status: 200 }); // ack; nothing to do
  }

  const { blobUrl, filename } = await readJob(id);

  try {
    const res = await fetch(TRANSCRIPT_URL(id), {
      headers: { "xi-api-key": apiKey },
    });
    if (!res.ok) throw new Error(`get-transcript ${res.status}`);
    const data = (await res.json()) as ScribeResponse;
    const durationSecs = data.audio_duration_secs ?? 0;
    const { markdown, speakerCount, wordCount } = toMarkdown(
      data,
      filename,
      durationSecs,
    );
    const langCode = (data.language_code ?? "").toLowerCase();
    await put(
      `results/${id}.json`,
      JSON.stringify({
        status: "done",
        filename: `${filename.replace(/\.[^/.]+$/, "") || "transcript"}.md`,
        markdown,
        meta: {
          durationSecs,
          language: LANGUAGE_NAMES[langCode] ?? langCode ?? "auto",
          languageCode: langCode,
          languageProbability: data.language_probability ?? null,
          speakerCount,
          wordCount,
        },
      }),
      {
        access: "public",
        addRandomSuffix: false,
        contentType: "application/json",
        allowOverwrite: true,
      },
    );
  } catch (err) {
    console.error("[webhook] processing failed:", err);
    await put(
      `results/${id}.json`,
      JSON.stringify({
        status: "error",
        error: "Transcription could not be processed.",
      }),
      {
        access: "public",
        addRandomSuffix: false,
        contentType: "application/json",
        allowOverwrite: true,
      },
    ).catch(() => {});
  }

  // Delete the recording now that we're done with it (daily cron is the
  // backstop for anything that never reached this point).
  if (blobUrl) await del(blobUrl).catch(() => {});

  return new Response("ok", { status: 200 });
}
