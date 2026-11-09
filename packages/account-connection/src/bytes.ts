import { z } from "zod";

// RPC values are buffered across app isolates. Bound downloads even when the
// upstream omits Content-Length or sends more than the declared length.
export const maximumDownloadBytes = 8 * 1024 * 1024;

export const readBytes = async (response: Response, maximum = maximumDownloadBytes) => {
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel();

    return { status: "too_large", maximumBytes: maximum } as const;
  }

  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read();

        if (chunk.done) break;
        const value = z.instanceof(Uint8Array).parse(chunk.value);
        length += value.byteLength;

        if (length > maximum) {
          await reader.cancel();

          return { status: "too_large", maximumBytes: maximum } as const;
        }

        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  const data = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { status: "connected", data } as const;
};
