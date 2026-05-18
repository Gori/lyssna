# Deploy on Vercel

Architecture: the browser uploads audio **directly to Vercel Blob** (bypasses the
4.5 MB function limit). A short function hands the blob URL to ElevenLabs Scribe v2
with `webhook=true`. ElevenLabs calls `/api/webhook` when done; the browser polls
`/api/result`. Recordings are deleted in the webhook and by a daily cleanup cron.

## One-time setup

1. **Import the repo into Vercel** and deploy once (so you have a domain).

2. **Create a Blob store**: Vercel project → Storage → Create → Blob →
   access **Public** → connect to the project. This auto-adds
   `BLOB_READ_WRITE_TOKEN`.

3. **ElevenLabs webhook**: ElevenLabs dashboard → Settings → Webhooks → create a
   Speech-to-Text webhook pointing to `https://<your-domain>/api/webhook`.
   Copy the signing secret.

4. **Environment variables** (Vercel → Settings → Environment Variables):
   - `ELEVENLABS_API_KEY` — your ElevenLabs key
   - `ELEVENLABS_WEBHOOK_SECRET` — the webhook signing secret from step 3
   - `CRON_SECRET` — optional; any random string. If set, it secures the daily
     cleanup cron (Vercel injects it automatically for cron calls).

5. **Redeploy.** `vercel.json` registers the daily cleanup cron
   (`/api/cleanup`, 04:00 UTC — once/day, Hobby-compatible).

## Notes

- Upload cap is 2 GB (ElevenLabs `cloud_storage_url` limit) — fine for 2 h meetings.
- Recordings are deleted immediately after their transcription completes; the
  daily cron removes anything older than 24 h as a backstop.
- No login. Anyone with the URL can transcribe; deploy behind access control if
  that matters.
