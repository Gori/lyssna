import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mints a short-lived client token so the browser can upload the audio file
// directly to Vercel Blob (bypassing the 4.5 MB serverless body limit).
// Public access is required so ElevenLabs can fetch it via cloud_storage_url;
// the path gets a random suffix (unguessable) and the file is deleted after
// transcription / by the daily cleanup cron.
const TWO_GB = 2 * 1000 * 1000 * 1000; // ElevenLabs cloud_storage_url limit

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as HandleUploadBody;
  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ["audio/*", "video/*"],
        maximumSizeInBytes: TWO_GB,
        addRandomSuffix: true,
        validUntil: Date.now() + 60 * 60 * 1000,
      }),
      onUploadCompleted: async () => {
        // No-op: the browser drives the next step (/api/submit) itself.
      },
    });
    return Response.json(jsonResponse);
  } catch (error) {
    return Response.json(
      { error: (error as Error).message },
      { status: 400 },
    );
  }
}
