import { fail } from "@/lib/api/wrappers";

export class BodyLimitError extends Error {
  constructor(public readonly status: 408 | 413) {
    super(status === 413 ? "Request body too large." : "Request body timed out.");
  }
}

/** Counts actual bytes, including chunked requests and dishonest Content-Length. */
export async function readLimitedBody(request: Pick<Request, "headers" | "body">, limit: number, timeoutMs = 30_000): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length")) > limit) throw new BodyLimitError(413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BodyLimitError(408)), timeoutMs);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new BodyLimitError(413);
      chunks.push(value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

export async function readWebhookBody(request: Request, requestId?: string) {
  try {
    return new TextDecoder().decode(await readLimitedBody(request, 5 * 1024 * 1024));
  } catch (error) {
    return fail(error instanceof BodyLimitError ? "invalid_body" : "invalid_request",
      error instanceof BodyLimitError ? error.message : "Unable to read request body.",
      error instanceof BodyLimitError ? error.status : 400, { requestId });
  }
}

export async function readLimitedFormData(request: Request, limit: number): Promise<FormData> {
  const bytes = await readLimitedBody(request, limit);
  return new Response(bytes as BodyInit, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
}
