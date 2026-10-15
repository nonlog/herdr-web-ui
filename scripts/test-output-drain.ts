/**
 * Capture all test output, but do not wait forever when a test has already
 * exited and a Herdr child inherited its stdout pipe.
 *
 * The parent still checks the actual test exit code and the Bun test counts.
 * Inherited-pipe EOF is not a substitute for a successful test result.
 */
export interface TestOutputResult {
  output: string;
  exitCode: number;
  inheritedPipe: boolean;
}

export async function collectTestOutput(
  stream: ReadableStream<Uint8Array>,
  exited: Promise<number>,
  drainGraceMs = 2_000,
  onChunk?: (text: string) => void,
): Promise<TestOutputResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let readError: unknown = null;
  const reading = (async (): Promise<void> => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        output += text;
        onChunk?.(text);
      }
      output += decoder.decode();
    } catch (error) {
      readError = error;
    } finally {
      reader.releaseLock();
    }
  })();

  const exitCode = await exited;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ended = await Promise.race([
    reading.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), drainGraceMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (!ended) {
    // The test itself has exited. The only remaining reader is an inherited
    // descriptor; do not kill Herdr's other sessions to wait for that EOF.
    void reader.cancel().catch(() => undefined);
    await reading;
  }
  if (readError !== null && ended) throw readError;
  return { output, exitCode, inheritedPipe: !ended };
}
