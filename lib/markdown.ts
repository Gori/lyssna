// Shared transcript → markdown logic, used by the webhook route.

export type ScribeWord = {
  text: string;
  start?: number | null;
  end?: number | null;
  type?: "word" | "spacing" | "audio_event" | string;
  speaker_id?: string | null;
};

export type ScribeResponse = {
  language_code?: string;
  language_probability?: number;
  text?: string;
  words?: ScribeWord[];
  audio_duration_secs?: number;
  transcription_id?: string | null;
};

export const LANGUAGE_NAMES: Record<string, string> = {
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

export function humanDuration(totalSeconds: number): string {
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

type Segment = { speakerId: string | null; start: number; text: string };

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

export function toMarkdown(
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
  const speakerLabel = (id: string | null): string =>
    !id ? "Speaker 1" : `Speaker ${speakerOrder.indexOf(id) + 1}`;

  const langCode = (data.language_code ?? "").toLowerCase();
  const langName = LANGUAGE_NAMES[langCode];
  const langLine = langCode
    ? langName
      ? `${langName} (${langCode})`
      : langCode
    : "auto-detected";

  const wordCount = words.filter((w) => w.type === "word").length;

  const today = new Date().toISOString().slice(0, 10);
  const header = [
    `# ${baseName}`,
    "",
    `- **Transcribed:** ${today}`,
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
      body.push(`## ${speakerLabel(seg.speakerId)} · [${timestamp(seg.start)}]`);
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
