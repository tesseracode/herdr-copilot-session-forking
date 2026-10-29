import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";

const [sourceId, childId, sourceMarker, childMarker] = process.argv.slice(2);
assert(sourceId && childId && sourceMarker && childMarker,
  "Usage: node scripts/check-history.mjs SOURCE_ID CHILD_ID SOURCE_MARKER CHILD_MARKER");
assert.notEqual(sourceId, childId);
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (name.startsWith("HERDR_")) delete env[name];
}
const client = new CopilotClient({
  connection: RuntimeConnection.forStdio({
    path: fileURLToPath(new URL("../node_modules/.bin/copilot", import.meta.url)),
    env,
  }),
  logLevel: "error",
});

async function userMessages(sessionId) {
  const messages = [];
  let cursor;
  for (let pages = 0; pages < 100; pages++) {
    const page = await client.rpc.sessions.readPersistedEvents({ sessionId, cursor, max: 1000 });
    assert.equal(page.cursorStatus, "ok", "Persisted history snapshot expired");
    messages.push(...page.events.filter((event) => event.type === "user.message")
      .map((event) => event.data.content));
    if (!page.hasMore) return messages;
    assert(page.nextCursor, "Missing continuation cursor");
    cursor = page.nextCursor;
  }
  throw new Error("History exceeds this disposable-test reader's page limit");
}

try {
  await client.start();
  const source = await userMessages(sourceId);
  const child = await userMessages(childId);
  assert(source.some((text) => text.includes(sourceMarker)), "Source marker missing");
  assert(child.some((text) => text.includes(sourceMarker)), "Forked source history missing");
  assert(child.some((text) => text.includes(childMarker)), "Child marker missing");
  assert(!source.some((text) => text.includes(childMarker)), "Child prompt leaked into source");
  console.log(JSON.stringify({ sourceId, childId, historyPreserved: true, sourceIsolated: true }));
} finally {
  const errors = await client.stop();
  if (errors.length) throw new AggregateError(errors, "History reader shutdown failed");
}
