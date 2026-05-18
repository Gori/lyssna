"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { jsPDF } from "jspdf";
import { upload } from "@vercel/blob/client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Status = "idle" | "ready" | "working" | "done" | "error";

type Result = {
  markdown: string;
  filename: string;
  meta: {
    durationSecs: number;
    language: string;
    languageCode: string;
    languageProbability: number | null;
    speakerCount: number;
    wordCount: number;
  };
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
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

/** Inline **bold** and _italic_ → React nodes (text auto-escaped by React). */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|_(.+?)_/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] != null)
      out.push(<strong key={`${keyBase}-${i}`}>{m[1]}</strong>);
    else out.push(<em key={`${keyBase}-${i}`}>{m[2]}</em>);
    last = re.lastIndex;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Render the markdown subset this app produces. No HTML injection. */
function renderMarkdown(md: string): ReactNode[] {
  const lines = md.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let k = 0;
  const flush = () => {
    if (para.length) {
      const text = para.join(" ");
      blocks.push(
        <p key={`p${k++}`} className="mt-3 text-[15px] leading-relaxed text-ink">
          {inline(text, `p${k}`)}
        </p>,
      );
      para = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === "") {
      flush();
    } else if (line.startsWith("# ")) {
      flush();
      blocks.push(
        <h2
          key={`h${k++}`}
          className="text-[20px] font-bold tracking-tight text-ink"
        >
          {line.slice(2)}
        </h2>,
      );
    } else if (line.startsWith("## ")) {
      flush();
      blocks.push(
        <h3
          key={`h${k++}`}
          className="mt-7 text-[15px] font-bold text-teal"
        >
          {line.slice(3)}
        </h3>,
      );
    } else if (line === "---") {
      flush();
      blocks.push(
        <hr key={`hr${k++}`} className="my-5 border-line-soft" />,
      );
    } else if (line.startsWith("- ")) {
      flush();
      blocks.push(
        <p
          key={`li${k++}`}
          className="mt-1 font-mono text-[13px] text-muted"
        >
          {inline(line.slice(2), `li${k}`)}
        </p>,
      );
    } else {
      para.push(line);
    }
  }
  flush();
  return blocks;
}

function buildPdf(filename: string, markdown: string): jsPDF {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 56;
  const maxW = pageW - margin * 2;
  let y = margin;
  const strip = (s: string) =>
    s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/_(.+?)_/g, "$1");
  const block = (
    text: string,
    size: number,
    style: "normal" | "bold",
    gap: number,
  ) => {
    doc.setFont("helvetica", style);
    doc.setFontSize(size);
    const lh = size * 1.42;
    for (const ln of doc.splitTextToSize(text, maxW) as string[]) {
      if (y + lh > pageH - margin) {
        doc.addPage();
        y = margin;
      }
      doc.text(ln, margin, y);
      y += lh;
    }
    y += gap;
  };
  for (const raw of markdown.replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    if (line === "") y += 4;
    else if (line.startsWith("# ")) block(line.slice(2), 22, "bold", 8);
    else if (line.startsWith("## ")) {
      y += 8;
      block(line.slice(3), 13, "bold", 3);
    } else if (line === "---") {
      doc.setDrawColor(210);
      if (y + 14 > pageH - margin) {
        doc.addPage();
        y = margin;
      }
      doc.line(margin, y, pageW - margin, y);
      y += 16;
    } else if (line.startsWith("- ")) block(strip(line.slice(2)), 10, "normal", 2);
    else block(strip(line), 11, "normal", 4);
  }
  return doc;
}

export default function Home() {
  const [status, setStatus] = useState<Status>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [clientDuration, setClientDuration] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const [numSpeakers, setNumSpeakers] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);
  const objectUrlRef = useRef<string | null>(null);
  const dragDepth = useRef(0);

  const revokeUrl = () => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  };

  useEffect(() => () => revokeUrl(), []);

  // Live elapsed counter so a long transcription clearly shows progress.
  useEffect(() => {
    if (status !== "working") return;
    const started = Date.now();
    const id = setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, [status]);

  const acceptFile = useCallback((f: File) => {
    setFile(f);
    setErrorMsg("");
    setResult(null);
    setStatus("ready");
    setClientDuration(null);
    revokeUrl();
    const url = URL.createObjectURL(f);
    objectUrlRef.current = url;
    const audio = new Audio();
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setClientDuration(audio.duration);
      }
    };
    audio.src = url;
  }, []);

  // Drop a file anywhere on the page.
  useEffect(() => {
    const onEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      dragDepth.current += 1;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const onLeave = () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      const f = e.dataTransfer?.files?.[0];
      if (f && status !== "working") acceptFile(f);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [acceptFile, status]);

  const reset = () => {
    revokeUrl();
    setFile(null);
    setResult(null);
    setErrorMsg("");
    setClientDuration(null);
    setNumSpeakers("");
    setStatus("idle");
    if (inputRef.current) inputRef.current.value = "";
  };

  const transcribe = async () => {
    if (!file) return;
    setElapsed(0);
    setStatus("working");
    setErrorMsg("");
    try {
      // 1. Upload straight from the browser to Vercel Blob (no 4.5 MB cap).
      const blob = await upload(`uploads/${file.name}`, file, {
        access: "public",
        handleUploadUrl: "/api/blob-upload",
      });

      // 2. Hand the blob URL to the server, which submits it to ElevenLabs.
      const sres = await fetch("/api/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          blobUrl: blob.url,
          filename: file.name,
          numSpeakers,
        }),
      });
      const sdata = await sres.json();
      if (!sres.ok) {
        setErrorMsg(sdata?.error || `Submit failed (${sres.status}).`);
        setStatus("error");
        return;
      }

      // 3. Poll until the webhook has stored the finished transcript.
      const id: string = sdata.transcriptionId;
      const deadline = Date.now() + 40 * 60 * 1000;
      while (Date.now() < deadline) {
        await sleep(5000);
        let d: { status?: string; error?: string } & Partial<Result>;
        try {
          const r = await fetch(`/api/result?id=${encodeURIComponent(id)}`, {
            cache: "no-store",
          });
          d = await r.json();
        } catch {
          continue; // transient network blip — keep polling
        }
        if (d.status === "done" && d.markdown) {
          setResult(d as Result);
          setStatus("done");
          return;
        }
        if (d.status === "error") {
          setErrorMsg(d.error || "Transcription failed.");
          setStatus("error");
          return;
        }
      }
      setErrorMsg(
        "This is taking unusually long (over 40 minutes). It may still finish in your ElevenLabs history.",
      );
      setStatus("error");
    } catch (err) {
      setErrorMsg(
        (err as Error)?.message ||
          "Upload was interrupted. Check your connection and try again.",
      );
      setStatus("error");
    }
  };

  const download = () => {
    if (!result) return;
    const blob = new Blob([result.markdown], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = result.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadPdf = () => {
    if (!result) return;
    buildPdf(result.filename, result.markdown).save(
      result.filename.replace(/\.md$/, ".pdf"),
    );
  };

  const copy = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const openPicker = () => inputRef.current?.click();

  const btn =
    "inline-flex items-center justify-center rounded-full font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal/30 disabled:opacity-50";
  const btnSolid = `${btn} bg-ink text-cream hover:bg-teal h-14 px-9 text-[18px]`;
  const btnGhost = `${btn} border border-line text-ink hover:bg-mist h-14 px-8 text-[18px]`;

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-6 py-20">
      <input
        ref={inputRef}
        type="file"
        accept="audio/*,video/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.mp4,.webm"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) acceptFile(f);
        }}
      />

      {dragging && status !== "working" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-cream/95 p-10">
          <div className="flex h-full w-full items-center justify-center rounded-2xl border border-dashed border-ink/30">
            <p className="text-[clamp(1.75rem,5vw,3rem)] font-bold tracking-tight text-ink">
              Drop to transcribe
            </p>
          </div>
        </div>
      )}

      <div className="w-full">
        {(status === "idle" || status === "ready") && (
          <div className="mx-auto max-w-5xl text-center">
            <h1 className="whitespace-nowrap text-[clamp(4rem,17vw,14rem)] font-bold leading-none tracking-[-0.012em] text-ink">
              lyssna
            </h1>

            {status === "idle" && (
              <div className="mt-9 flex flex-col items-center gap-6">
                <button onClick={openPicker} className={btnSolid}>
                  Choose a recording
                </button>
                <p className="text-[16px] text-faint">
                  or drop a file anywhere on this page
                </p>
              </div>
            )}

            {status === "ready" && file && (
              <div className="mt-12">
                <p className="truncate font-mono text-[18px] text-ink">
                  {file.name}
                </p>
                <p className="mt-2 font-mono text-[15px] text-faint">
                  {formatBytes(file.size)}
                  {clientDuration ? ` · ${humanDuration(clientDuration)}` : ""}
                </p>
                <div className="mt-9 flex items-center justify-center gap-3 text-[15px] text-faint">
                  <label htmlFor="ns">Speakers</label>
                  <div className="relative">
                    <select
                      id="ns"
                      value={numSpeakers}
                      onChange={(e) => setNumSpeakers(e.target.value)}
                      aria-label="Number of speakers"
                      className="h-11 cursor-pointer appearance-none rounded-full border border-line bg-transparent pl-5 pr-10 font-mono text-[15px] text-ink outline-none transition-colors hover:border-ink/40 focus:border-ink"
                    >
                      <option value="">Auto-detect</option>
                      {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                    <svg
                      aria-hidden
                      className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2"
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                    >
                      <path
                        d="M6 9l6 6 6-6"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                </div>
                <div className="mt-9 flex flex-col items-center gap-5">
                  <button
                    onClick={transcribe}
                    className={`${btnSolid} w-full max-w-sm`}
                  >
                    Transcribe
                  </button>
                  <button
                    onClick={openPicker}
                    className="text-[15px] text-faint underline decoration-line underline-offset-4 transition-colors hover:text-ink"
                  >
                    choose a different file
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {status === "working" && (
          <div className="mx-auto max-w-xl text-center" aria-live="polite">
            <p className="font-mono text-[clamp(4rem,14vw,7rem)] font-medium tabular-nums leading-none tracking-tight text-ink">
              {clock(elapsed)}
            </p>
            <p className="mx-auto mt-10 max-w-[36ch] text-[19px] leading-relaxed text-muted">
              Transcribing. A two-hour meeting takes a few minutes, don&apos;t
              close this tab.
            </p>
          </div>
        )}

        {status === "error" && (
          <div className="mx-auto max-w-xl text-center" aria-live="polite">
            <h1 className="text-[clamp(2.25rem,6vw,3.25rem)] font-bold tracking-tight text-ink">
              That didn’t work
            </h1>
            <p className="mx-auto mt-6 max-w-[42ch] text-[19px] leading-relaxed text-muted">
              {errorMsg}
            </p>
            <button onClick={reset} className={`${btnGhost} mt-10`}>
              Start over
            </button>
          </div>
        )}

        {status === "done" && result && (
          <div className="mx-auto w-full max-w-6xl">
            <h1 className="break-words text-center text-[clamp(2rem,5vw,3rem)] font-bold tracking-tight text-ink">
              {result.filename.replace(/\.md$/, "")}
            </h1>

            <p className="mt-6 text-center font-mono text-[15px] text-faint">
              {[
                result.meta.language || "auto",
                humanDuration(result.meta.durationSecs),
                `${result.meta.speakerCount} ${
                  result.meta.speakerCount === 1 ? "speaker" : "speakers"
                }`,
                `${result.meta.wordCount.toLocaleString("en-US")} words`,
              ].join("  ·  ")}
            </p>

            <div className="mt-9 flex flex-wrap justify-center gap-4">
              <button onClick={download} className={btnSolid}>
                Download .md
              </button>
              <button onClick={downloadPdf} className={btnSolid}>
                Download PDF
              </button>
              <button onClick={copy} className={btnGhost}>
                {copied ? "Copied" : "Copy markdown"}
              </button>
            </div>

            <div className="mt-10 grid gap-5 lg:grid-cols-2">
              <div>
                <p className="mb-2 font-mono text-[12px] text-faint">
                  markdown
                </p>
                <pre className="tscroll h-[58vh] overflow-auto rounded-2xl border border-line bg-paper p-7 font-mono text-[13.5px] leading-relaxed whitespace-pre-wrap break-words text-ink">
                  {result.markdown}
                </pre>
              </div>
              <div>
                <p className="mb-2 font-mono text-[12px] text-faint">
                  preview
                </p>
                <div className="tscroll h-[58vh] overflow-auto rounded-2xl border border-line bg-paper px-8 py-7">
                  {renderMarkdown(result.markdown).map((b, i) => (
                    <Fragment key={i}>{b}</Fragment>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-7 text-center">
              <button
                onClick={reset}
                className="text-[15px] text-faint underline decoration-line underline-offset-4 transition-colors hover:text-ink"
              >
                transcribe another
              </button>
            </div>
          </div>
        )}
      </div>

      {status === "idle" && (
        <p className="fixed bottom-6 left-0 right-0 text-center font-mono text-[12px] text-faint">
          O ❤️ A
        </p>
      )}
    </main>
  );
}
