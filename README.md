# Agnes Video DeepAgent

A resumable Node.js/TypeScript agent that turns a prompt into one continuous 4–12 second Agnes Video 2.5 Flash render with an enriched native sound design, preserves that embedded soundtrack when it is usable, falls back to precisely timed ElevenLabs effects when it is not, and overlays an optional quiet Free.ai ACE-Step music bed before assembling an H.264/AAC MP4 with bundled FFmpeg.

Every prompt invocation gets an isolated `runs/<run-id>/` directory, even when identical prompts are triggered simultaneously. Plans, provider receipts, checkpoints, and artifacts remain local; no database is used. Continue a pending run explicitly with `--resume <run-id>` so accepted tasks and existing artifacts are reused without making a duplicate request.

## Generation lifecycle

The planning LLM expands a short concept into a small visual story with a setup, development, and payoff. Unless the prompt explicitly requests a shorter result, it targets 10–12 seconds and uses the extra time for same-context anticipation, environmental reveal, readable development, reaction, or aftermath—not unrelated filler or frozen holds. Explicit 4–9 second duration requests remain supported. It deliberately uses only 2–4 broad beats, one dominant action per beat, wider timing windows, and simple sequential choreography that Agnes can plausibly render. It creates one gap-free global timeline, not multiple video clips. It preserves sounds named by the user and also infers a small natural soundscape from visible subjects, actions, materials, and environment. Every retained sound-causing action starts with the same absolute timestamp in:

- the Agnes visual prompt;
- the shared Agnes-native/ElevenLabs-fallback cue sheet; and
- the local FFmpeg mix.

For example, a cricket shot can request bat contact near `2.20s` and the crowd reaction near `8.10s`. After Agnes is downloaded, FFprobe first checks for an audio stream and FFmpeg measures its peak, mean, and active duration over the planned timeline. A meaningful embedded track becomes the primary diegetic soundtrack, so no vision or ElevenLabs call is made. If the source has no audio or only silence, FFmpeg makes a 4 fps timestamped overview and 12 fps close timing strips. The fallback vision pass locates each visible cause from the rendered frames, retimes supported events, and omits absent or uncertain ones. ElevenLabs then creates only those isolated effects and local FFmpeg places them at the observed sample positions.

Video uses Agnes's asynchronous API:

```text
fresh run: POST /v1/videos
             -> persist id + task_id + video_id + submitting-key fingerprint
             -> GET /agnesapi every 30 seconds for at most 8 minutes

resume:    npm run dev -- --resume <run-id>
             -> load persisted receipt
             -> GET /agnesapi with the exact submitting key
             -> never POST the accepted task again

complete:  normalize metadata.url or the live top-level url
             -> download atomically -> video/source.mp4
pending:   exit successfully; resume that run to poll another 8 minutes
failed:    retain the terminal provider receipt and report the failure
queue full without a receipt: retain a retry-safe failure; resume submits again
```

Every submission, accepted task, poll result, eight-minute timeout, reuse, download, source-audio inspection, foreground-audio selection, fallback vision decision, and omission is printed as a structured `[video-agent]` event. When fallback is needed and a compatible Groq Qwen vision model is configured, the pass uses its non-thinking JSON mode and bounded adaptive rate-limit retries; numbered `GROQ_API_KEY_n` values rotate after a key remains rate-limited. It fails safely for a later resume after that pool is exhausted instead of silently accepting weaker timing from another model. Installations without compatible Groq credentials use the configured vision-provider pool. `--status` reads local state only and never contacts Agnes or a vision provider.

The documentation describes the completed asset as `metadata.url`, while the live Video 2.5 Flash retrieval response currently exposes it as a top-level `url`. Both forms are normalized. If Agnes reports `completed` before either URL is available, polling continues for the rest of the eight-minute window and a later invocation resumes retrieval from the same receipt.

The Agnes contract is documented at [Agnes Video 2.5 Flash](https://www.agnes-ai.com/en/docs/agnes-video-25-flash). This project sends `model=agnes-video-2.5-flash`, `mode=text`, `size=720P`, `n=1`, an integer `seconds` value from 4 through 12, and a supported aspect ratio. Style, camera motion, timed actions, and negative constraints are composed into the ordinary prompt because the documented request body has no separate fields for those controls.

## Audio

There are two final mix layers, with a conditional choice for the first:

1. Diegetic foreground sound normally comes directly from the Agnes MP4. The Agnes prompt explicitly requests planned roars, impacts, engines, rain, animal calls, crowd reactions, and other visible-source sounds while forbidding provider-added score. If inspection finds no usable source signal, ElevenLabs Sound Effects (`eleven_text_to_sound_v2`) becomes the fallback using the same cue sheet and the existing vision-timing pass.
2. Background music uses Free.ai ACE-Step. The planner first derives genre, 30–300 BPM tempo, featured instrument, mood, and a broad phrase timeline from the story's actual action, stakes, atmosphere, and payoff. ACE-Step receives both the concise concept and complete creative script as emotional scoring context, so action, thriller, romance, horror, peaceful, and playful stories receive appropriately different musical direction. Explicit user music controls still win. The provider is told to create a sparse instrumental/no-vocals bed—not literal sound effects—and the local mix keeps it low and continuous.

An explicit `no background music`, `Foley only`, or `sound effects only` instruction disables the music call. Otherwise music is requested and the LLM selects suitable defaults when the prompt omits genre, BPM, or instrument. Music is best-effort: if no usable track is available after the bounded attempt cycle, the checkpoint is durably marked `skipped` and the same invocation continues with the selected diegetic soundtrack only. Later invocations reuse that decision and do not spend another music request.

The mix is intentionally diegetic-first. Native Agnes audio is resampled to 48 kHz stereo and trimmed or padded to the final duration without loudness normalization, preserving its original dynamics and synchronization. For fallback only, each isolated Foley request describes the visible source/action, material, acoustic distance, attack/decay, and explicit exclusions; effectively silent assets are omitted and natural fades plus deterministic stereo placement are applied. Music is normalized as a source and held at a steady default linear gain of `0.10` over either foreground mode. A final limiter prevents clipping without stopping or ducking the music around individual sounds.

Foley follows the official [ElevenLabs Sound Effects API](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert). Music uses Free.ai's documented ACE-Step endpoint and Bearer authentication; see the [Free.ai music page](https://free.ai/music/) and [API reference](https://free.ai/api/).

ACE-Step normally produces at least 10 seconds. For a 4–9 second video the provider creates 10 seconds, the musical prompt resolves the useful arc by the end of the video, and FFmpeg trims the unused tail. The provider prompt treats the chosen BPM as the perceived pulse, rejects double-time feel and busy subdivisions, and uses timeline windows for broad texture rather than duplicating diegetic hits. A music operation makes one initial attempt plus three retries for any API/provider error. Generation retries advance through `FREE_AI_API_AUDIO_KEY_n`. Once generation returns a media URL, that receipt is written to local state before its bounded download attempts. FFprobe validates the downloaded file before it can become a completed checkpoint, so an HTML/error body served with a generic content type selects the durable no-music fallback. A process interruption after the atomic download reuses the local track without another provider request; otherwise an active receipt resumes only its download. A cleanly exhausted generation or download cycle permanently selects diegetic-only output for that run. Because the synchronous API documents no idempotency key, retrying a timeout or lost response before a URL arrives can create more than one billed generation; this is the explicit bounded retry policy requested for music.

## Local state and reuse

The normalized prompt produces a stable 64-character run ID:

```text
runs/
  <run-id>/
    run.json
    plan.json
    pipeline-state.json
    agent-state.json
    conversation_history/
    analysis/
      source-audio.json
      coarse-*.jpg
      fine-*.jpg
      observed-foley-plan.json
    video/
      source.mp4
    audio/
      foley-cues/*.mp3
      foley-mix.wav
      music.wav              when successfully generated
    two-dinosaurs-fighting-in-a-jungle-1.mp4
```

Final filenames are derived deterministically from the user prompt after removing generic command wording and host-only control markers. Unsafe filesystem punctuation is replaced, names are UTF-8 byte-bounded, and the assembly attempt remains as a numeric suffix. Retained legacy `final-N.mp4` checkpoints continue to work.

The plan is immutable once validated. Completed local artifacts are checksummed and reused. The source-audio decision is bound to the exact source-video checksum, duration, and inspection revision. A native selection reuses that source directly; a fallback Foley stem is additionally bound to its exact vision reconciliation. Each final MP4 records the foreground mode plus the source, source-audio analysis, optional Foley/reconciliation, and included-music checksums (or durable skipped/disabled music state), so changing any retained dependency forces a deterministic rebuild instead of reusing a stale mix. Agnes retrieval is bound to the full SHA-256 fingerprint of the key that submitted the task, so changing key order cannot make a resumed run poll the wrong account. API keys and signed media URLs are not exposed in status output.

There is one unavoidable ambiguity boundary: if the process loses the connection after Agnes may have accepted the POST but before it receives `video_id`, the application cannot safely prove whether a job exists. Agnes documents no idempotency key or account-history lookup for this API. The checkpoint is therefore marked `unknown` and automatic resubmission is blocked, preventing an accidental duplicate render. In contrast, Agnes's explicit `video queue is full, please retry later` response contains no accepted-task receipt and is stored as retry-safe; resuming that run reuses the locked plan but makes a new POST. Older checkpoints that misclassified that exact response as `unknown` are migrated automatically only when they contain no task ID, external ID, URL, or provider receipt.

Generated artifacts are retained after success by default. They are removed only when the original user prompt explicitly asks for cleanup after successful generation. Even then, the final MP4 is checksum- and FFprobe-validated first; only `video/`, `audio/`, `analysis/`, and superseded final files are removed.

## Configuration

Requirements:

- Node.js 20+
- credentials for the configured deep-agent LLM providers
- at least one Agnes API key
- at least one supported vision-provider key only when Agnes source audio is missing or unusable and fallback timing inspection is required
- at least one ElevenLabs key only when fallback Foley must be generated
- at least one Free.ai audio key to attempt optional background music; the video still completes with its selected diegetic track when none is configured or all attempts fail
- Google OAuth credentials only for explicitly requested YouTube uploads

```bash
cd /Users/a81178043/work/freeai-video-deepagent
cp .env.example .env
npm install
```

Relevant environment values:

```dotenv
AGNES_API_KEY_1=agnes-one
AGNES_API_KEY_2=agnes-two
AGNES_BASE_URL=https://apihub.agnes-ai.com
AGNES_REQUEST_TIMEOUT_MS=60000
AGNES_POLL_INTERVAL_MS=30000
AGNES_POLL_WINDOW_MS=480000
AGNES_MAX_DOWNLOAD_BYTES=500000000

NVIDIA_API_KEY_1=nvidia-vision-one
NVIDIA_API_KEY_2=nvidia-vision-two
NVIDIA_VISION_MODEL=nvidia/nemotron-3-nano-omni-30b-a3b-reasoning
REQUEST_TIMEOUT_MS=60000

FREE_AI_API_AUDIO_KEY_1=free-ai-audio-one
FREE_AI_API_AUDIO_KEY_2=free-ai-audio-two
FREE_AI_BASE_URL=https://api.free.ai
FREE_AI_REQUEST_TIMEOUT_MS=180000
FREE_AI_RETRY_DELAY_MS=6000
FREE_AI_MUSIC_MAX_DOWNLOAD_BYTES=67108864

ELEVENLABS_API_KEY_1=eleven-one
ELEVENLABS_API_KEY_2=eleven-two
ELEVENLABS_BASE_URL=https://api.elevenlabs.io
ELEVENLABS_REQUEST_TIMEOUT_MS=180000

VIDEO_STYLE=cinematic
VIDEO_ASPECT_RATIO=16:9
VIDEO_FPS=24
VIDEO_MUSIC_VOLUME=0.10
VIDEO_FOLEY_VOLUME=1.00
VIDEO_OUTPUT_ROOT=./runs

YOUTUBE_UPLOAD_ENABLED=false
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_REDIRECT_URI=http://127.0.0.1:53682/oauth2/callback
YOUTUBE_REFRESH_TOKEN=
YOUTUBE_DEFAULT_PRIVACY=private
YOUTUBE_DEFAULT_MADE_FOR_KIDS=false
YOUTUBE_DEFAULT_CONTAINS_SYNTHETIC_MEDIA=true
```

Numbered Agnes, ElevenLabs, Groq vision, and Free.ai keys are sorted numerically, may contain gaps, and are deduplicated by this app. Agnes submission moves to another Agnes key only for a definite key-scoped quota/credit/rate rejection; an accepted task always continues with its original fingerprint-matched key. ElevenLabs Foley retains its exhaustion-only key rotation. Compatible Groq Qwen vision keys receive a short bounded same-key retry for a provider-specified rate delay, then advance through the numbered pool. Free.ai music advances to the next audio key on every generation retry, regardless of provider error type, for at most three retries after the initial request. Without compatible Groq credentials, post-render vision uses the external orchestrator's supported NVIDIA, Cloudflare, Groq, Hugging Face, SambaNova, or Cerebras providers.

## Prompt controls

The CLI resolves explicit controls before the LLM writes its plan and logs the final locked configuration:

- Visual style: `cinematic`, `animation`, `realistic`, `artistic`, `vintage`, `anime`, `film-noir`, `documentary`, `commercial`, `music-video`.
- Aspect ratio: `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16`.
- Camera motion: `static`, slow pan/tilt/zoom, slow orbit, handheld, dolly forward, or crane up.
- Negative constraints: label them as `negative prompt:`, `negative bible:`, or `avoid:`. Otherwise the LLM authors suitable exclusions.
- Music: genre, BPM, and featured instrument such as piano, guitar, saxophone, violin, synth, flute, harp, or drums.
- Cleanup: explicitly ask to clean up intermediate artifacts after successful generation; otherwise everything is retained.

The default aspect ratio is landscape `16:9`. An explicit supported ratio such as `9:16` in the prompt still overrides it.

## YouTube uploads

YouTube upload remains opt-in: start the run with the explicit `--youtube` capability flag and configure `YOUTUBE_UPLOAD_ENABLED=true`. Free-form prompt text alone never authorizes publication, so a story or tutorial that merely mentions uploading cannot accidentally publish. For an authorized upload, the LLM locks a story-specific title, description, 5–12 unique tags, and a relevant YouTube category into `plan.json`. The upload sends all of them together with host-controlled privacy, made-for-kids, synthetic-media disclosure, and subscriber-notification settings. Metadata is validated locally against YouTube's title, UTF-8 description, prohibited-character, and aggregate tag limits before the MP4 is opened.

To enable the path, first enable YouTube Data API v3 in the Google Cloud project, configure its OAuth consent screen and exact redirect URI, authorize the target channel with the `youtube.upload` scope, and place the resulting refresh token in `YOUTUBE_REFRESH_TOKEN`. The token must belong to the same OAuth client ID/secret and an account with a YouTube channel. Set `YOUTUBE_DEFAULT_PRIVACY` and `YOUTUBE_DEFAULT_MADE_FOR_KIDS` deliberately; these policy-sensitive values override LLM suggestions. AI-generated output defaults to `YOUTUBE_DEFAULT_CONTAINS_SYNTHETIC_MEDIA=true` and subscriber notifications are disabled.

Uploads from some unaudited Google Cloud projects can be forced to private by YouTube even when another visibility is requested. The uploader reports the effective privacy returned by the API. See [videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert), [video metadata fields](https://developers.google.com/youtube/v3/docs/videos#resource), and [offline OAuth access](https://developers.google.com/identity/protocols/oauth2/web-server#offline).

If the connection is lost after an upload starts, the local checkpoint becomes `unknown` and automatic retry is blocked—even after restart or if uploading is later disabled. Check YouTube Studio and reconcile that checkpoint manually; this fail-closed behavior prevents silently publishing a duplicate.

Examples:

```bash
npm run dev -- "Two dinosaurs fight in a jungle, cinematic 16:9, handheld camera, rock at 130 BPM with drums"
npm run dev -- "A car follows a coastal road and discovers a lighthouse at sunset; realistic 21:9, relaxed pop at 105 BPM featuring guitar"
npm run dev -- "A batsman hits a six and the crowd roars; Foley only, no background music"
npm run dev -- "Captain America shields a frightened child from a meteor; animation style, avoid: captions and duplicate characters"
npm run dev -- --youtube "A red kite masters a gusty hill"
```

## Commands

| Command | Purpose |
|---|---|
| `npm run dev -- "<prompt>"` | Start a new isolated run, including for an identical prompt |
| `npm run dev -- --youtube "<prompt>"` | Start a run with explicit YouTube publication authorization |
| `npm run dev -- --resume <run-id>` | Resume the stored original prompt |
| `npm run dev -- --status <run-id>` | Print local progress without provider calls |
| `npm run typecheck` | Strict TypeScript validation |
| `npm test` | Offline provider-mocked tests |
| `npm run build` | Compile to `dist/` |
| `npm run media:smoke` | Exercise bundled FFmpeg locally |

Do not commit `.env`, OAuth tokens, generated media, or run state.
