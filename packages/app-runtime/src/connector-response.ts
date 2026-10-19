import { z } from "zod";

export const connectorResponse = (
  response: Response,
  signal: AbortSignal,
  context: Pick<ExecutionContext, "waitUntil">,
) => {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let complete = () => {};

  const lifetime = new Promise<void>((resolve) => {
    complete = resolve;
  });

  let cancellation: Promise<void> | undefined;

  const finish = () => {
    signal.removeEventListener("abort", abort);
    complete();
  };

  const cancel = () => (cancellation ??= reader.cancel().finally(finish));

  const abort = () => {
    context.waitUntil(cancel());
  };

  // Keep draining tied to the source, including asynchronous cancel cleanup.
  // workerd can leave a response pipe waiting on a pending read after the
  // caller disconnects; cancel its reader explicitly from the request signal.
  context.waitUntil(lifetime);
  signal.addEventListener("abort", abort, { once: true });

  if (signal.aborted) abort();

  return new Response(
    new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const chunk = await reader.read();

            if (cancellation) return;

            if (chunk.done) {
              controller.close();
              finish();
            } else controller.enqueue(z.instanceof(Uint8Array).parse(chunk.value));
          } catch (cause) {
            controller.error(cause);
            finish();
          }
        },
        cancel,
      },
      { highWaterMark: 0 },
    ),
    response,
  );
};
