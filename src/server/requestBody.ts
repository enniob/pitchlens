/** Bounded ingress reading, including clients which never finish sending. */
export class BodyReadError extends Error {
  constructor(readonly code: "payload-too-large" | "timeout" | "invalid-request") {
    super(code);
    this.name = "BodyReadError";
  }
}

export async function readLimitedBody(request: Request, limit: number, timeoutMs = 5_000): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    void request.body?.cancel().catch(() => {});
    throw new BodyReadError("payload-too-large");
  }
  if (request.signal.aborted) throw new BodyReadError("timeout");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const signal = AbortSignal.any([request.signal, deadline.signal]);
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => {
      // A hostile stream's cancel promise must not delay timeout handling.
      void reader.cancel().catch(() => {});
      reject(new BodyReadError("timeout"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (signal.aborted) abort();
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), interrupted]);
      if (signal.aborted) throw new BodyReadError("timeout");
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        throw new BodyReadError("payload-too-large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof BodyReadError) throw error;
    throw new BodyReadError(signal.aborted ? "timeout" : "invalid-request");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
