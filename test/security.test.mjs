import assert from "node:assert/strict";
import test from "node:test";
import { XMLParser } from "fast-xml-parser";
import { fetchBoundedText, readBoundedText } from "../extensions/fetch-text.ts";

test("rejects repeated DOCTYPE declarations instead of resetting entity limits", () => {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  assert.throws(() => parser.parse('<!DOCTYPE feed [<!ENTITY a "one">]><!DOCTYPE feed [<!ENTITY b "two">]><feed>&a;&b;</feed>'), /Multiple DOCTYPE/);
  assert.equal(parser.parse('<feed><title>A &amp; B</title></feed>').feed.title, "A & B");
});

test("enforces streamed byte limits without trusting Content-Length and cancels overflow", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3, 4]));
    },
    cancel() { cancelled = true; },
  }), { headers: { "content-length": "1" } });
  await assert.rejects(readBoundedText(response, 3), /exceeds/);
  assert.equal(cancelled, true);
});

test("decodes multibyte UTF-8 across chunks and rejects an excessive declared size", async () => {
  const bytes = new TextEncoder().encode("π");
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(bytes.slice(0, 1));
    controller.enqueue(bytes.slice(1));
    controller.close();
  } });
  assert.equal(await readBoundedText(new Response(stream), 2), "π");
  await assert.rejects(readBoundedText(new Response("x", { headers: { "content-length": "100" } }), 2), /exceeds/);
});

test("combines caller cancellation with a request deadline without live networking", async t => {
  const controller = new AbortController();
  let requestSignal;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requestSignal = options.signal;
    return new Response("paper");
  });
  assert.equal(await fetchBoundedText(new URL("https://example.invalid"), "test", controller.signal), "paper");
  assert.notEqual(requestSignal, controller.signal);
  controller.abort();
  assert.equal(requestSignal.aborted, true);
});
