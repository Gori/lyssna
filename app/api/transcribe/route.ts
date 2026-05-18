import type { NextRequest } from "next/server";

// Long meetings are transcribed asynchronously: we submit the job, then poll
// ElevenLabs for the result. Each upstream call is short, so nothing hits a
// gateway timeout. The browser↔this-route connection stays open meanwhile
// (fine on localhost / self-host; raise the platform function limit if you
// deploy serverless).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

const STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const TRANSCRIPT_URL = (id: string) =>
  `https://api.elevenlabs.io/v1/speech-to-text/transcripts/${id}`;

const POLL_INTERVAL_MS = 6000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 min ceiling

type ScribeWord = {
  text: string;
  start?: number | null;
  end?: number | null;
  type?: "word" | "spacing" | "audio_event" | string;
  speaker_id?: string | null;
};

type ScribeResponse = {
  language_code?: string;
  language_probability?: number;
  text?: string;
  words?: ScribeWord[];
  audio_duration_secs?: number;
  transcription_id?: string | null;
};

const LANGUAGE_NAMES: Record<string, string> = {
  swe: "Swedish",
  sv: "Swedish",
  eng: "English",
  en: "English",
  nor: "Norwegian",
  dan: "Danish",
  deu: "German",
  fra: "French",
  spa: "Spanish",
  fin: "Finnish",
};

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function timestamp(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

function humanDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m || h) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(" ");
}

type Segment = {
  speakerId: string | null;
  start: number;
  text: string;
};

/**
 * Group the flat word stream into speaker turns. Spacing tokens carry the
 * inter-word whitespace and inherit the current turn; a new turn begins when a
 * word/audio_event token reports a different speaker.
 */
function buildSegments(words: ScribeWord[]): Segment[] {
  const segments: Segment[] = [];
  let current: Segment | null = null;
  let currentSpeaker: string | null = null;

  for (const w of words) {
    const isContent = w.type !== "spacing";
    if (isContent) {
      const speaker: string | null = w.speaker_id ?? currentSpeaker ?? null;
      if (!current || speaker !== currentSpeaker) {
        const fallbackStart: number = current?.start ?? 0;
        currentSpeaker = speaker;
        current = {
          speakerId: speaker,
          start: typeof w.start === "number" ? w.start : fallbackStart,
          text: "",
        };
        segments.push(current);
      }
    }
    if (!current) {
      current = { speakerId: currentSpeaker, start: 0, text: "" };
      segments.push(current);
    }
    if (w.type === "audio_event") {
      const tag = w.text.trim().replace(/^\(|\)$/g, "");
      current.text += ` _(${tag})_ `;
    } else {
      current.text += w.text;
    }
  }

  return segments
    .map((s) => ({ ...s, text: s.text.replace(/\s+/g, " ").trim() }))
    .filter((s) => s.text.length > 0);
}

function toMarkdown(
  data: ScribeResponse,
  filename: string,
  durationSecs: number,
): { markdown: string; speakerCount: number; wordCount: number } {
  const baseName = filename.replace(/\.[^/.]+$/, "") || "transcript";
  const words = Array.isArray(data.words) ? data.words : [];
  const segments = buildSegments(words);

  const speakerOrder: string[] = [];
  for (const seg of segments) {
    if (seg.speakerId && !speakerOrder.includes(seg.speakerId)) {
      speakerOrder.push(seg.speakerId);
    }
  }
  const speakerLabel = (id: string | null): string => {
    if (!id) return "Speaker 1";
    return `Speaker ${speakerOrder.indexOf(id) + 1}`;
  };

  const langCode = (data.language_code ?? "").toLowerCase();
  const langName = LANGUAGE_NAMES[langCode];
  const langLine = langCode
    ? langName
      ? `${langName} (${langCode})`
      : langCode
    : "auto-detected";

  const wordCount = words.filter((w) => w.type === "word").length;

  const header = [
    `# ${baseName}`,
    "",
    `- **Transcribed:** 2026-05-18`,
    `- **Duration:** ${humanDuration(durationSecs)}`,
    `- **Primary language:** ${langLine}`,
    `- **Speakers:** ${Math.max(speakerOrder.length, 1)}`,
    "",
    "---",
    "",
  ];

  const body: string[] = [];
  if (segments.length === 0) {
    body.push((data.text ?? "").trim() || "_(no speech detected)_");
  } else {
    for (const seg of segments) {
      body.push(
        `## ${speakerLabel(seg.speakerId)} · [${timestamp(seg.start)}]`,
      );
      body.push("");
      body.push(seg.text);
      body.push("");
    }
  }

  return {
    markdown: header.join("\n") + body.join("\n").trimEnd() + "\n",
    speakerCount: Math.max(speakerOrder.length, 1),
    wordCount,
  };
}

function isComplete(data: ScribeResponse): boolean {
  return (
    (Array.isArray(data.words) && data.words.length > 0) ||
    typeof data.text === "string"
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll the transcript endpoint until the job is finished or we time out. */
async function pollTranscript(
  id: string,
  apiKey: string,
): Promise<ScribeResponse> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  await sleep(POLL_INTERVAL_MS);
  while (Date.now() < deadline) {
    const res = await fetch(TRANSCRIPT_URL(id), {
      headers: { "xi-api-key": apiKey },
    });
    if (res.ok) {
      const body = (await res.json()) as ScribeResponse;
      if (isComplete(body)) return body;
    } else if (res.status !== 404 && res.status !== 425 && res.status !== 202) {
      // 404/425/202 = still being prepared; anything else is a real failure.
      let detail = `Transcript fetch returned ${res.status}.`;
      try {
        const e = await res.json();
        if (typeof e?.detail === "string") detail = e.detail;
        else if (e?.detail?.message) detail = e.detail.message;
      } catch {
        /* keep generic */
      }
      throw new Error(detail);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    "Transcription is taking unusually long (over 30 minutes). It may still finish in your ElevenLabs history.",
  );
}

export async function POST(request: NextRequest) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return Response.json(
      {
        error:
          "Missing ELEVENLABS_API_KEY. Add it to .env.local and restart the dev server.",
      },
      { status: 500 },
    );
  }

  let incoming: FormData;
  try {
    incoming = await request.formData();
  } catch (err) {
    console.error("[transcribe] formData parse failed:", err);
    return Response.json(
      { error: "Could not read the upload. Try a smaller or different file." },
      { status: 400 },
    );
  }

  const file = incoming.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return Response.json(
      { error: "No audio file was provided." },
      { status: 400 },
    );
  }

  const upstream = new FormData();
  upstream.set("file", file, file.name);
  upstream.set("model_id", "scribe_v2");
  upstream.set("diarize", "true");
  upstream.set("timestamps_granularity", "word");
  upstream.set("tag_audio_events", "true");
  upstream.set("no_verbatim", "true");
  // No language_code: Scribe v2 auto-detects and handles Swedish/English
  // code-switching within a single recording.

  const ns = Number.parseInt(String(incoming.get("num_speakers") ?? ""), 10);
  if (Number.isInteger(ns) && ns >= 1 && ns <= 32) {
    upstream.set("num_speakers", String(ns));
  }

  let submitData: ScribeResponse;
  try {
    const res = await fetch(STT_URL, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: upstream,
    });
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
      console.error("[transcribe] submit failed:", res.status, detail);
      return Response.json({ error: detail }, { status: res.status });
    }
    submitData = (await res.json()) as ScribeResponse;
  } catch (err) {
    const cause = (err as { cause?: unknown })?.cause ?? err;
    console.error("[transcribe] submit threw:", err, "\ncause:", cause);
    return Response.json(
      {
        error: `Could not reach the ElevenLabs API (${
          (cause as Error)?.message || String(cause)
        }).`,
      },
      { status: 502 },
    );
  }

  // A short clip may already be complete in the submit response.
  let data: ScribeResponse = submitData;
  if (!isComplete(submitData)) {
    const id = submitData.transcription_id;
    if (!id) {
      console.error("[transcribe] no transcription_id in submit response:", submitData);
      return Response.json(
        { error: "ElevenLabs did not return a transcription id." },
        { status: 502 },
      );
    }
    try {
      data = await pollTranscript(id, apiKey);
    } catch (err) {
      console.error("[transcribe] polling failed:", err);
      return Response.json(
        { error: (err as Error).message || "Transcription failed." },
        { status: 502 },
      );
    }
  }

  const durationSecs = data.audio_duration_secs ?? 0;
  const { markdown, speakerCount, wordCount } = toMarkdown(
    data,
    file.name,
    durationSecs,
  );
  const langCode = (data.language_code ?? "").toLowerCase();

  return Response.json({
    markdown,
    filename: `${file.name.replace(/\.[^/.]+$/, "") || "transcript"}.md`,
    meta: {
      durationSecs,
      language: LANGUAGE_NAMES[langCode] ?? langCode ?? "auto",
      languageCode: langCode,
      languageProbability: data.language_probability ?? null,
      speakerCount,
      wordCount,
    },
  });
}
