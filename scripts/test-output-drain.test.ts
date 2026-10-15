import { expect, test } from "bun:test";
import { collectTestOutput } from "./test-output-drain.ts";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

test("collects the complete test summary and preserves exit code", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes(" 13 pass\n"));
      controller.enqueue(bytes(" 0 fail\n"));
      controller.close();
    },
  });
  expect(await collectTestOutput(stream, Promise.resolve(0), 40)).toEqual({
    output: " 13 pass\n 0 fail\n",
    exitCode: 0,
    inheritedPipe: false,
  });
});

test("after test process exit, an inherited stdout pipe cannot hold integration CI forever", async () => {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes(" 130 pass\n 0 fail\n"));
      // Do not close: a descendant Herdr server still inherited stdout.
    },
    cancel() { canceled = true; },
  });
  const result = await collectTestOutput(stream, Promise.resolve(0), 20);
  expect(result).toEqual({
    output: " 130 pass\n 0 fail\n",
    exitCode: 0,
    inheritedPipe: true,
  });
  expect(canceled).toBe(true);
});

test("the actual test exit failure survives inherited-pipe handling", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes(" 12 pass\n 1 fail\n"));
    },
  });
  const result = await collectTestOutput(stream, Promise.resolve(1), 20);
  expect(result.exitCode).toBe(1);
  expect(result.inheritedPipe).toBe(true);
  expect(result.output).toContain("1 fail");
});
