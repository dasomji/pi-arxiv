export const MAX_REMOTE_BYTES = 20 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;

export async function readBoundedText(response: Response, maxBytes = MAX_REMOTE_BYTES): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Remote response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`Remote response exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function fetchBoundedText(url: URL, userAgent: string, signal?: AbortSignal): Promise<string> {
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetch(url, {
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    headers: { "user-agent": userAgent },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Request failed: HTTP ${response.status} ${response.statusText} for ${url.toString()}`);
  }
  return readBoundedText(response);
}
