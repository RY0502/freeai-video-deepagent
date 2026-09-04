import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DeepAgentRunner } from "freetier-deepagent-framework";

import { scopeFrameworkFilesystemToRunDirectory } from "../src/agent/scopedFilesystemBackend.js";
import { LocalFrameworkDatabase } from "../src/state/localFrameworkDatabase.js";

test("conversation-history virtual paths are written beneath the prompt run directory", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "video-history-root-"));
  const runDirectory = path.join(temporaryRoot, "a".repeat(64));
  try {
    const database = new LocalFrameworkDatabase(runDirectory);
    const runner = new DeepAgentRunner(database.asDatabaseClient());
    const backend = scopeFrameworkFilesystemToRunDirectory(runner, runDirectory);
    const historyPath = "/conversation_history/session_scoped_test.md";

    const initial = await backend.write(historyPath, "first section\n");
    assert.equal(initial.error, undefined);

    const downloaded = await backend.downloadFiles([historyPath]);
    assert.equal(downloaded[0]?.error ?? undefined, undefined);
    assert.equal(new TextDecoder().decode(downloaded[0]?.content), "first section\n");

    const appended = new TextEncoder().encode("first section\nsecond section\n");
    const uploaded = await backend.uploadFiles([[historyPath, appended]]);
    assert.equal(uploaded[0]?.error ?? undefined, undefined);

    const localHistoryPath = path.join(
      runDirectory,
      "conversation_history",
      "session_scoped_test.md",
    );
    assert.equal(await readFile(localHistoryPath, "utf8"), "first section\nsecond section\n");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("filesystem scoping fails closed if the pinned framework backend shape changes", () => {
  assert.throws(
    () => scopeFrameworkFilesystemToRunDirectory(
      { backend: {} } as unknown as DeepAgentRunner,
      "/tmp/unused-video-run",
    ),
    /no longer exposes the expected filesystem backend internals/,
  );
});
