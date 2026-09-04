import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { VideoPlan } from "../src/agent/videoPlan.js";
import type { ProcessRunner } from "../src/media/index.js";
import {
  FOLEY_RECONCILIATION_REVISION,
  applyFoleyVisionObservations,
  createFoleyVisionClient,
  createGroqStructuredVisionProvider,
  loadReusableFoleyReconciliation,
  parseFoleyVisionResponse,
  plannedFoleyCueDigest,
  reconcileFoleyPlanToRenderedVideo,
  renderCoarseFoleyContactSheet,
  type FoleyVisionClient,
  type RawFoleyVisionObservation,
} from "../src/vision/index.js";
import { sha256File } from "../src/utils/files.js";

const ambience = {
  atSeconds: 0,
  sound: "quiet courtyard air",
  durationSeconds: 4,
  intensity: "subtle",
  spatialPosition: "moving",
  category: "ambience",
  prominence: "ambient",
  visualAction: "The open stone courtyard remains visible throughout the continuous shot.",
  continuous: true,
  cueId: "air",
  timingClass: "approximate",
} as const;

const impact = {
  atSeconds: 1,
  sound: "wooden staff contact",
  durationSeconds: 0.2,
  intensity: "strong",
  spatialPosition: "left",
  category: "impact",
  prominence: "foreground",
  visualAction: "The wooden staff visibly strikes the hanging practice block once.",
  continuous: false,
  cueId: "staff-hit",
  timingClass: "must_sync",
} as const;

const unsupported = {
  atSeconds: 2.5,
  sound: "foot whoosh",
  durationSeconds: 0.3,
  intensity: "medium",
  spatialPosition: "right",
  category: "movement",
  prominence: "foreground",
  visualAction: "The performer makes one fast high kick toward frame right.",
  continuous: false,
  cueId: "kick",
  timingClass: "must_sync",
} as const;

function plan(): VideoPlan {
  return {
    schemaVersion: 2,
    concept: "A martial artist demonstrates one staff strike in a quiet courtyard.",
    creativeScript: "A martial artist settles into stance, performs one clear wooden staff strike against a hanging block, and returns to a calm pose while the courtyard stays unchanged.",
    totalDurationSeconds: 4,
    continuityBible: {
      subjects: [{ id: "artist", role: "primary", invariantAppearance: "same artist", wardrobeOrSurface: "cotton", props: [], identityAnchors: [] }],
      environment: { location: "stone courtyard", backgroundAnchors: [], timeOfDay: "day", weatherOrAtmosphere: "still" },
    },
    timelineBeats: [
      {
        beatId: "strike",
        startSeconds: 0,
        endSeconds: 2,
        visualAction: "[0.00s] The open stone courtyard remains visible throughout the continuous shot. [1.00s] The wooden staff visibly strikes the hanging practice block once.",
      },
      {
        beatId: "kick",
        startSeconds: 2,
        endSeconds: 4,
        visualAction: "[2.50s] The performer makes one fast high kick toward frame right.",
      },
    ],
    foleyCues: [ambience, impact, unsupported],
  } as unknown as VideoPlan;
}

function observation(overrides: Partial<RawFoleyVisionObservation>): RawFoleyVisionObservation {
  return {
    cueId: "staff-hit",
    visible: true,
    matchesPlannedCause: true,
    observedAtSeconds: 1.25,
    confidence: 0.92,
    observedAction: "The staff first touches the hanging wooden block.",
    soundDescription: "one dry close wooden knock with a short natural decay",
    reason: "Direct material contact is visible in adjacent timestamped frames.",
    ...overrides,
  };
}

test("vision JSON parsing requires every requested cue exactly once and consistent visibility", () => {
  const cues = [impact, unsupported];
  const valid = JSON.stringify({ cues: [
    observation({}),
    observation({
      cueId: "kick",
      visible: false,
      matchesPlannedCause: false,
      observedAtSeconds: null,
      confidence: 0.2,
      observedAction: null,
      soundDescription: null,
      reason: "No kick is visible.",
    }),
  ] });
  assert.equal(parseFoleyVisionResponse(`\n\`\`\`json\n${valid}\n\`\`\``, cues, 4).length, 2);
  assert.throws(
    () => parseFoleyVisionResponse(JSON.stringify({ cues: [observation({}), observation({})] }), cues, 4),
    /duplicate cue IDs/i,
  );
  assert.throws(
    () => parseFoleyVisionResponse(JSON.stringify({ cues: [observation({})] }), cues, 4),
    /exactly the requested cue IDs/i,
  );
  assert.throws(
    () => parseFoleyVisionResponse(JSON.stringify({ cues: [
      observation({ visible: false, matchesPlannedCause: false, observedAtSeconds: 1.25 }),
      observation({ cueId: "kick", visible: false, matchesPlannedCause: false, observedAtSeconds: null }),
    ] }), cues, 4),
    /Invisible cue staff-hit must have a null timestamp/i,
  );
});

test("malformed vision JSON advances to the next configured provider", async () => {
  const valid = JSON.stringify({ cues: [observation({})] });
  let firstCalls = 0;
  let secondCalls = 0;
  const client = createFoleyVisionClient([
    {
      name: "truncated-provider",
      async invoke() {
        firstCalls += 1;
        return '{"cues":[';
      },
      getModelConfig: () => ({ textModel: "text-a", visionModel: "vision-a" }),
    },
    {
      name: "valid-provider",
      async invoke() {
        secondCalls += 1;
        return valid;
      },
      getModelConfig: () => ({ textModel: "text-b", visionModel: "vision-b" }),
    },
  ]);
  const result = await client.analyze({ system: "system", prompt: "prompt" }, (text) => {
    parseFoleyVisionResponse(text, [impact], 4);
  });
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 1);
  assert.equal(result.provider, "valid-provider");
  assert.equal(result.model, "vision-b");
});

test("Groq vision uses documented non-thinking JSON mode", async () => {
  let requestBody: Record<string, unknown> | null = null;
  const provider = createGroqStructuredVisionProvider({
    apiKey: "test-secret",
    model: "qwen/qwen3.6-27b",
    requestTimeoutMs: 5_000,
    maxCompletionTokens: 4_096,
    fetchImpl: (async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ cues: [observation({})] }) } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });
  const output = await provider.invoke({
    system: "Return JSON.",
    prompt: "Inspect this image.",
    imageBase64: "ZmFrZS1qcGVn",
    mimeType: "image/jpeg",
  });
  assert.equal(JSON.parse(output).cues[0].cueId, "staff-hit");
  assert.ok(requestBody);
  const captured = requestBody as Record<string, unknown>;
  assert.equal(captured.reasoning_effort, "none");
  assert.deepEqual(captured.response_format, { type: "json_object" });
  assert.equal(captured.max_completion_tokens, 4_096);
});

test("Groq vision honors a bounded provider 429 retry delay", async () => {
  let calls = 0;
  const waits: number[] = [];
  const provider = createGroqStructuredVisionProvider({
    apiKey: "test-secret",
    model: "qwen/qwen3.6-27b",
    requestTimeoutMs: 5_000,
    maxCompletionTokens: 4_096,
    maxRateLimitRetries: 1,
    sleep: async (milliseconds) => { waits.push(milliseconds); },
    fetchImpl: (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({
          error: { message: "Rate limited. Please try again in 0.1s.", code: "rate_limit_exceeded" },
        }), { status: 429, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ cues: [observation({})] }) } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });
  const output = await provider.invoke({
    system: "Return JSON.",
    prompt: "Inspect this image.",
    imageBase64: "ZmFrZS1qcGVn",
  });
  assert.equal(JSON.parse(output).cues[0].cueId, "staff-hit");
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2_000]);
});

test("host policy preserves ambience, retimes supported action, and omits uncertain action", () => {
  const coarse = [
    observation({
      cueId: "air",
      observedAtSeconds: 0,
      confidence: 0.95,
      observedAction: "The open stone courtyard remains clearly visible.",
      soundDescription: "quiet open-air courtyard ambience",
    }),
    observation({ observedAtSeconds: 1 }),
    observation({
      cueId: "kick",
      visible: true,
      observedAtSeconds: 2.7,
      confidence: 0.6,
      observedAction: "A leg shifts but no fast kick is clear.",
      soundDescription: "light cloth movement",
      reason: "Motion is partially occluded.",
    }),
  ];
  const fine = [observation({ observedAtSeconds: 1.25, confidence: 0.92 })];
  const result = applyFoleyVisionObservations(plan(), coarse, fine);

  assert.deepEqual(result.decisions.map(({ cueId, decision, resolvedAtSeconds }) => ({
    cueId,
    decision,
    resolvedAtSeconds,
  })), [
    { cueId: "air", decision: "keep", resolvedAtSeconds: 0 },
    { cueId: "staff-hit", decision: "retime", resolvedAtSeconds: 1.25 },
    { cueId: "kick", decision: "omit", resolvedAtSeconds: null },
  ]);
  assert.deepEqual(result.activeCues.map(({ cueId }) => cueId), ["air", "staff-hit"]);
  assert.match(result.activeCues[1]?.sound ?? "", /dry close wooden knock/);
  assert.equal(result.activeCues[1]?.visualAction, "The staff first touches the hanging wooden block.");
});

test("host policy rejects semantic substitutions and unsupported continuous beds", () => {
  const result = applyFoleyVisionObservations(plan(), [
    observation({
      cueId: "air",
      visible: false,
      matchesPlannedCause: false,
      observedAtSeconds: null,
      confidence: 0.2,
      observedAction: null,
      soundDescription: null,
      reason: "The environment is not visible clearly enough.",
    }),
    observation({ observedAtSeconds: 1, confidence: 0.9 }),
    observation({ cueId: "kick", observedAtSeconds: 2.6, confidence: 0.9 }),
  ], [
    observation({
      visible: true,
      matchesPlannedCause: false,
      observedAtSeconds: 1.2,
      confidence: 0.95,
      observedAction: "The artist raises both arms without touching the block.",
      soundDescription: "soft cloth movement",
      reason: "Motion is visible, but no staff-to-block contact occurs.",
    }),
    observation({ cueId: "kick", observedAtSeconds: 2.65, confidence: 0.9 }),
  ]);

  assert.deepEqual(result.decisions.map(({ cueId, decision }) => ({ cueId, decision })), [
    { cueId: "air", decision: "omit" },
    { cueId: "staff-hit", decision: "omit" },
    { cueId: "kick", decision: "retime" },
  ]);
  assert.deepEqual(result.activeCues.map(({ cueId }) => cueId), ["kick"]);
});

test("impact timing falls back to the confident full-timeline contact when fine timing disagrees", () => {
  const impactOnlyPlan = { ...plan(), foleyCues: [impact] } as VideoPlan;
  const result = applyFoleyVisionObservations(
    impactOnlyPlan,
    [observation({ observedAtSeconds: 1.5, confidence: 0.95 })],
    [observation({ observedAtSeconds: 1, confidence: 0.95 })],
  );

  assert.equal(result.activeCues[0]?.atSeconds, 1.5);
  assert.match(result.decisions[0]?.reason ?? "", /fine and coarse contact timing disagreed/i);
});

test("surface splash timing prefers first full-timeline contact over later peak spray", () => {
  const splash = {
    ...unsupported,
    cueId: "surface-splash",
    sound: "water splash",
    visualAction: "The dolphin breaks the surface and creates one splash.",
  } as const;
  const splashPlan = { ...plan(), foleyCues: [splash] } as VideoPlan;
  const result = applyFoleyVisionObservations(
    splashPlan,
    [observation({ cueId: splash.cueId, observedAtSeconds: 2.25, confidence: 0.95 })],
    [observation({ cueId: splash.cueId, observedAtSeconds: 2.75, confidence: 0.95 })],
  );

  assert.equal(result.activeCues[0]?.atSeconds, 2.25);
  assert.match(result.decisions[0]?.reason ?? "", /fine and coarse contact timing disagreed/i);
});

test("host policy bounds retiming to the planned beat and deduplicates collapsed events", () => {
  const supportedAir = observation({
    cueId: "air",
    observedAtSeconds: 0,
    confidence: 0.95,
    observedAction: "The open stone courtyard remains clearly visible.",
    soundDescription: "quiet open-air courtyard ambience",
  });
  const outside = applyFoleyVisionObservations(plan(), [
    supportedAir,
    observation({ observedAtSeconds: 1, confidence: 0.9 }),
    observation({ cueId: "kick", observedAtSeconds: 2.6, confidence: 0.9 }),
  ], [
    observation({ observedAtSeconds: 3, confidence: 0.95 }),
    observation({ cueId: "kick", observedAtSeconds: 2.6, confidence: 0.9 }),
  ]);
  assert.equal(outside.decisions.find(({ cueId }) => cueId === "staff-hit")?.decision, "omit");
  assert.match(
    outside.decisions.find(({ cueId }) => cueId === "staff-hit")?.reason ?? "",
    /outside.*allowed beat window/i,
  );

  const sameCategoryPlan = {
    ...plan(),
    foleyCues: [ambience, impact, { ...unsupported, category: "impact" }],
  } as VideoPlan;
  const collapsed = applyFoleyVisionObservations(sameCategoryPlan, [
    supportedAir,
    observation({ observedAtSeconds: 1.5, confidence: 0.8 }),
    observation({ cueId: "kick", observedAtSeconds: 1.55, confidence: 0.95 }),
  ], [
    observation({ observedAtSeconds: 1.5, confidence: 0.8 }),
    observation({ cueId: "kick", observedAtSeconds: 1.55, confidence: 0.95 }),
  ]);
  assert.deepEqual(collapsed.activeCues.map(({ cueId }) => cueId), ["air", "kick"]);
  assert.match(
    collapsed.decisions.find(({ cueId }) => cueId === "staff-hit")?.reason ?? "",
    /avoids duplicate Foley/i,
  );
});

test("same-category deduplication ignores cue-array order and intervening categories", () => {
  const secondImpact = {
    ...unsupported,
    cueId: "second-hit",
    category: "impact",
    sound: "a second wooden staff contact",
    visualAction: "The wooden staff visibly strikes the hanging practice block a second time.",
  } as const;
  const interleavedPlan = {
    ...plan(),
    foleyCues: [ambience, secondImpact, unsupported, impact],
  } as VideoPlan;
  const result = applyFoleyVisionObservations(interleavedPlan, [
    observation({
      cueId: "air",
      observedAtSeconds: 0,
      confidence: 0.95,
      observedAction: "The open stone courtyard remains clearly visible.",
      soundDescription: "quiet open-air courtyard ambience",
    }),
    observation({ cueId: "staff-hit", observedAtSeconds: 1.7, confidence: 0.8 }),
    observation({ cueId: "kick", observedAtSeconds: 1.6, confidence: 0.9 }),
    observation({ cueId: "second-hit", observedAtSeconds: 1.4, confidence: 0.95 }),
  ], [
    observation({ cueId: "staff-hit", observedAtSeconds: 1.7, confidence: 0.8 }),
    observation({ cueId: "kick", observedAtSeconds: 1.6, confidence: 0.9 }),
    observation({ cueId: "second-hit", observedAtSeconds: 1.4, confidence: 0.95 }),
  ]);

  assert.deepEqual(result.activeCues.map(({ cueId }) => cueId), ["air", "second-hit", "kick"]);
  assert.match(
    result.decisions.find(({ cueId }) => cueId === "staff-hit")?.reason ?? "",
    /avoids duplicate Foley/i,
  );
});

test("coarse and fine contact sheets drive two bounded vision calls and persist a reusable result", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "foley-vision-"));
  const sourcePath = path.join(directory, "source.mp4");
  const analysisDirectory = path.join(directory, "analysis");
  const outputPath = path.join(analysisDirectory, "observed-foley-plan.json");
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const runProcess: ProcessRunner = async (executable, args) => {
    calls.push({ executable, args });
    await writeFile(String(args.at(-1)), "jpeg-bytes");
    return { stdout: "", stderr: "" };
  };
  let visionCalls = 0;
  const vision: FoleyVisionClient = {
    async analyze(input) {
      visionCalls += 1;
      assert.equal(input.mimeType, "image/jpeg");
      assert.ok(input.imageBase64);
      assert.doesNotMatch(input.prompt, /"plannedAtSeconds"/i);
      if (visionCalls === 1) {
        return {
          text: JSON.stringify({ cues: [
            observation({ observedAtSeconds: 1, confidence: 0.9 }),
            observation({
              cueId: "air",
              observedAtSeconds: 0,
              confidence: 0.95,
              observedAction: "The open stone courtyard remains clearly visible.",
              soundDescription: "quiet open-air courtyard ambience",
            }),
            observation({
              cueId: "kick",
              visible: false,
              matchesPlannedCause: false,
              observedAtSeconds: null,
              confidence: 0.15,
              observedAction: null,
              soundDescription: null,
              reason: "No high kick is visible.",
            }),
          ] }),
          provider: "test-vision",
          model: "test-vlm",
        };
      }
      return {
        text: JSON.stringify({ cues: [observation({ observedAtSeconds: 1.25 })] }),
        provider: "test-vision",
        model: "test-vlm",
      };
    },
  };

  try {
    await writeFile(sourcePath, "source-video");
    const sourceSha256 = await sha256File(sourcePath);
    const document = await reconcileFoleyPlanToRenderedVideo({
      plan: plan(),
      sourceVideoPath: sourcePath,
      sourceVideoSha256: sourceSha256,
      analysisDirectory,
      outputPath,
      vision,
    }, { ffmpegPath: "/deps/ffmpeg", runProcess });

    assert.equal(visionCalls, 2);
    assert.equal(document.reconciliationRevision, FOLEY_RECONCILIATION_REVISION);
    assert.deepEqual(document.activeCues.map(({ cueId }) => cueId), ["air", "staff-hit"]);
    assert.equal(calls.some(({ args }) => String(args[args.indexOf("-vf") + 1]).includes("fps=4")), true);
    assert.equal(calls.some(({ args }) => String(args[args.indexOf("-vf") + 1]).includes("fps=12")), true);
    assert.equal(calls.some(({ args }) => String(args[args.indexOf("-vf") + 1]).includes("scale=224:126")), true);
    assert.equal(calls.some(({ args }) => String(args[args.indexOf("-vf") + 1]).includes("tile=6x6:nb_frames=36")), true);
    assert.equal(calls.some(({ args }) => String(args[args.indexOf("-vf") + 1]).includes("%{pts\\:hms}")), true);
    assert.equal(JSON.parse(await readFile(outputPath, "utf8")).schemaVersion, 2);

    const fileSha256 = await sha256File(outputPath);
    assert.ok(await loadReusableFoleyReconciliation({
      filePath: outputPath,
      expectedFileSha256: fileSha256,
      sourceVideoSha256: sourceSha256,
      plannedCueDigest: plannedFoleyCueDigest(plan()),
    }));
    assert.equal(await loadReusableFoleyReconciliation({
      filePath: outputPath,
      expectedFileSha256: fileSha256,
      sourceVideoSha256: "f".repeat(64),
      plannedCueDigest: plannedFoleyCueDigest(plan()),
    }), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fine vision splits visible transients into batches of at most two cues", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "foley-vision-batches-"));
  const sourcePath = path.join(directory, "source.mp4");
  const outputPath = path.join(directory, "analysis", "observed-foley-plan.json");
  const thirdCue = {
    ...impact,
    cueId: "second-hit",
    atSeconds: 3.2,
    visualAction: "The staff visibly taps a second wooden block once.",
  } as const;
  const batchPlan = { ...plan(), foleyCues: [ambience, impact, unsupported, thirdCue] } as VideoPlan;
  let visionCalls = 0;
  const fineBatchSizes: number[] = [];
  try {
    await writeFile(sourcePath, "source-video");
    const document = await reconcileFoleyPlanToRenderedVideo({
      plan: batchPlan,
      sourceVideoPath: sourcePath,
      sourceVideoSha256: await sha256File(sourcePath),
      analysisDirectory: path.dirname(outputPath),
      outputPath,
      vision: {
        async analyze() {
          visionCalls += 1;
          if (visionCalls === 1) {
            return {
              text: JSON.stringify({ cues: [
                observation({ cueId: "air", observedAtSeconds: 0 }),
                observation({ cueId: "staff-hit", observedAtSeconds: 1.1 }),
                observation({ cueId: "kick", observedAtSeconds: 2.6 }),
                observation({ cueId: "second-hit", observedAtSeconds: 3.2 }),
              ] }),
              provider: "coarse-provider",
              model: "test-vlm",
            };
          }
          const batch = visionCalls === 2
            ? [
                observation({ cueId: "staff-hit", observedAtSeconds: 1.1 }),
                observation({ cueId: "kick", observedAtSeconds: 2.6 }),
              ]
            : [observation({ cueId: "second-hit", observedAtSeconds: 3.2 })];
          fineBatchSizes.push(batch.length);
          return {
            text: JSON.stringify({ cues: batch }),
            provider: `fine-provider-${visionCalls - 1}`,
            model: "test-vlm",
          };
        },
      },
    }, {
      ffmpegPath: "/deps/ffmpeg",
      runProcess: async (_executable, args) => {
        await writeFile(String(args.at(-1)), "jpeg-bytes");
        return { stdout: "", stderr: "" };
      },
    });

    assert.equal(visionCalls, 3);
    assert.deepEqual(fineBatchSizes, [2, 1]);
    assert.deepEqual(document.providers, ["coarse-provider", "fine-provider-1", "fine-provider-2"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("zero-cue reconciliation creates local durable state without invoking vision", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "foley-vision-empty-"));
  const outputPath = path.join(directory, "analysis", "observed-foley-plan.json");
  let visionCalls = 0;
  try {
    const emptyPlan = { ...plan(), foleyCues: [] } as VideoPlan;
    const document = await reconcileFoleyPlanToRenderedVideo({
      plan: emptyPlan,
      sourceVideoPath: path.join(directory, "unused.mp4"),
      sourceVideoSha256: "a".repeat(64),
      analysisDirectory: path.dirname(outputPath),
      outputPath,
      vision: { async analyze() { visionCalls += 1; throw new Error("must not run"); } },
    });
    assert.equal(visionCalls, 0);
    assert.deepEqual(document.activeCues, []);
    assert.equal(document.coarseContactSheet, null);
    assert.equal(document.providers[0], "local-no-cues");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("contact-sheet generation uses direct FFmpeg args and atomic publication", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "foley-contact-sheet-"));
  const outputPath = path.join(directory, "nested", "coarse.jpg");
  let args: readonly string[] = [];
  try {
    await renderCoarseFoleyContactSheet({
      sourceVideoPath: path.join(directory, "source.mp4"),
      durationSeconds: 12,
      outputPath,
    }, {
      ffmpegPath: "/deps/ffmpeg",
      runProcess: async (_executable, currentArgs) => {
        args = currentArgs;
        await writeFile(String(currentArgs.at(-1)), "jpeg");
        return { stdout: "", stderr: "" };
      },
    });
    assert.equal(args.includes("-vf"), true);
    assert.match(String(args[args.indexOf("-vf") + 1]), /tile=8x6:nb_frames=48/);
    assert.match(String(args.at(-1)), /coarse\.jpg\.part-[0-9a-f-]+\.jpg$/);
    assert.equal(await readFile(outputPath, "utf8"), "jpeg");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
