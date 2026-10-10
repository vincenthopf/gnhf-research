import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import {
  describeChildProcessExit,
  parseJSONLStream,
  setupAbortHandler,
} from "./stream-utils.js";

function createMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

function createMockReadable() {
  return new EventEmitter();
}

describe("parseJSONLStream", () => {
  it("parses complete JSONL events across chunk boundaries and writes chunks to the log", () => {
    const stream = createMockReadable();
    const logStream = { write: vi.fn() };
    const callback = vi.fn();

    parseJSONLStream<{ type: string; value?: number }>(
      stream as never,
      logStream as never,
      callback,
    );

    stream.emit("data", Buffer.from('{"type":"first"}\n{"typ'));
    stream.emit("data", Buffer.from('e":"second","value":2}\n'));

    expect(logStream.write).toHaveBeenNthCalledWith(
      1,
      Buffer.from('{"type":"first"}\n{"typ'),
    );
    expect(logStream.write).toHaveBeenNthCalledWith(
      2,
      Buffer.from('e":"second","value":2}\n'),
    );
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenNthCalledWith(1, { type: "first" });
    expect(callback).toHaveBeenNthCalledWith(2, {
      type: "second",
      value: 2,
    });
  });

  it("skips blank and invalid lines while continuing to parse later events", () => {
    const stream = createMockReadable();
    const callback = vi.fn();

    parseJSONLStream<{ ok: boolean }>(stream as never, null, callback);

    stream.emit(
      "data",
      Buffer.from('\nnot json\n{"ok":true}\n   \n{"ok":false}\n'),
    );

    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenNthCalledWith(1, { ok: true });
    expect(callback).toHaveBeenNthCalledWith(2, { ok: false });
  });
});

describe("describeChildProcessExit", () => {
  it("quotes stderr content when the process exits non-zero", () => {
    expect(describeChildProcessExit("claude", 2, "", "boom").detail).toBe(
      "claude exited with code 2: boom",
    );
  });

  it("uses a structured stdout error when stderr is empty", () => {
    expect(
      describeChildProcessExit(
        "claude",
        1,
        '{"type":"error","error":{"message":"login required"}}\n',
        "",
      ).detail,
    ).toBe("claude exited with code 1: login required");
  });

  it("says so when a non-zero exit produced no output", () => {
    expect(describeChildProcessExit("claude", 1, "", "").detail).toBe(
      "claude exited with code 1 and produced no output",
    );
  });
});

describe("setupAbortHandler", () => {
  it("returns false when no signal is provided", () => {
    const child = createMockChild();

    expect(setupAbortHandler(undefined, child as never, vi.fn())).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("kills immediately and rejects when the signal is already aborted", () => {
    const controller = new AbortController();
    controller.abort();
    const child = createMockChild();
    const reject = vi.fn();

    const handled = setupAbortHandler(
      controller.signal,
      child as never,
      reject,
    );

    expect(handled).toBe(true);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(reject).toHaveBeenCalledWith(new Error("Agent was aborted"));
  });

  it("kills once on abort and removes the listener after the process closes", () => {
    const controller = new AbortController();
    const child = createMockChild();
    const reject = vi.fn();

    const handled = setupAbortHandler(
      controller.signal,
      child as never,
      reject,
    );
    expect(handled).toBe(false);

    controller.abort();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(reject).toHaveBeenCalledWith(new Error("Agent was aborted"));

    child.emit("close", 0);
    controller.abort();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
