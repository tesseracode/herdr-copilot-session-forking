import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";

const cli = fileURLToPath(new URL("../node_modules/.bin/copilot", import.meta.url));
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (name.startsWith("HERDR_")) delete env[name];
}
const client = new CopilotClient({
  connection: RuntimeConnection.forStdio({ path: cli, env }),
  workingDirectory: process.cwd(),
  logLevel: "error",
});
const config = {
  model: "claude-haiku-4.5",
  availableTools: [],
  onPermissionRequest: () => ({ kind: "denied-interactively-by-user" }),
};

async function worker(mode, sessionId) {
  await client.start();
  if (mode === "fork") {
    const child = await client.rpc.sessions.fork({ sessionId });
    assert.notEqual(child.sessionId, sessionId);
    return child;
  }
  const session = await client.resumeSession(sessionId, {
    ...config,
    continuePendingWork: false,
  });
  let inUse = false;
  const off = session.on("session.resume", (event) => {
    if (event.data.alreadyInUse) inUse = true;
  });
  try {
    const events = await session.getEvents();
    assert(events.some((event) => event.type === "user.message"
      && event.data.content.includes("FORK_SOURCE_MARKER")));
    assert.equal(inUse, false);
    await session.sendAndWait({ prompt: "Reply exactly FORK_CHILD_MARKER. Do not use tools." }, 90000);
    const after = await session.getEvents();
    assert(after.some((event) => event.type === "user.message"
      && event.data.content.includes("FORK_CHILD_MARKER")));
    return { sessionId, historyPreserved: true, childTurnCompleted: true };
  } finally {
    off();
  }
}

function runWorker(mode, sessionId) {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), [mode, sessionId], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env,
      timeout: 150000,
    });
    let result;
    child.on("message", (message) => { result = message; });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0 && result?.ok) resolve(result.value);
      else reject(new Error(`${mode} worker failed (${code ?? signal}): ${result?.error ?? "no result"}`));
    });
  });
}

try {
  if (process.argv[2]) {
    const value = await worker(process.argv[2], process.argv[3]);
    process.send({ ok: true, value });
  } else {
    await client.start();
    const source = await client.createSession(config);
    console.log(JSON.stringify({ phase: "source-created", sourceId: source.sessionId }));
    await source.sendAndWait({ prompt: "Reply exactly FORK_SOURCE_MARKER. Do not use tools." }, 90000);
    const before = await source.getEvents();
    const child = await runWorker("fork", source.sessionId);
    console.log(JSON.stringify({ phase: "fork-created", ...child }));
    const result = await runWorker("resume", child.sessionId);
    const after = await source.getEvents();
    assert(!after.some((event) => event.type === "user.message"
      && event.data.content.includes("FORK_CHILD_MARKER")));
    assert(before.every((event) => after.some((item) => item.id === event.id)));
    await source.sendAndWait({ prompt: "Reply exactly FORK_SOURCE_STILL_LIVE. Do not use tools." }, 90000);
    console.log(JSON.stringify({
      phase: "passed", sourceId: source.sessionId, childId: child.sessionId,
      ...result, sourceUnchangedByChild: true, sourceStillUsable: true,
    }));
  }
} catch (error) {
  if (process.send) process.send({ ok: false, error: error.message });
  else console.error(error);
  process.exitCode = 1;
} finally {
  const errors = await client.stop();
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  }
}
