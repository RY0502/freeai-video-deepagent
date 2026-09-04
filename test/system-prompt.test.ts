import assert from 'node:assert/strict';
import test from 'node:test';

import { createVideoSystemPrompt } from '../src/agent/systemPrompt.js';

function prompt(): string {
  return createVideoSystemPrompt({
    tools: {
      validatePlan: 'validate_video_plan',
      generateVideo: 'generate_video',
      generateMusic: 'generate_music_track',
      generateFoley: 'generate_foley_track',
      assembleVideo: 'assemble_final_video',
    },
    youtubeUploadRequested: false,
    youtubeUploadAuthorized: false,
  });
}

test('video system prompt plans one creative four-to-twelve-second Agnes render', () => {
  const value = prompt();
  assert.match(value, /Agnes Video 2\.5 Flash for one generated video/i);
  assert.match(value, /integer 4-12 seconds/i);
  assert.match(value, /Unless the user explicitly requests a shorter duration, target 10-12 seconds/i);
  assert.match(value, /never choose 4-9 seconds merely because the initial idea is brief/i);
  assert.match(value, /one continuous provider video, never a collection of short scene clips/i);
  assert.match(value, /concrete `creativeScript` with a setup, visible development, and payoff/i);
  assert.match(value, /two to eight gap-free `timelineBeats`/i);
  assert.match(value, /normally a 10-12 second duration/i);
  assert.match(value, /schemaVersion 2/);
});

test('video system prompt expands sparse ideas and compresses detailed prompts without changing their core', () => {
  const value = prompt();
  assert.match(value, /user's prompt is sparse, enrich only its central idea/i);
  assert.match(value, /clear setup, development or dominant action, and payoff/i);
  assert.match(value, /naturally occupies 10-12 seconds/i);
  assert.match(value, /useful anticipation, an environmental reveal, a readable reaction, or a settling aftermath/i);
  assert.match(value, /do not add unrelated subjects, locations, props, or plot twists merely to fill time/i);
  assert.match(value, /user's prompt is detailed, preserve its explicit subjects, constraints, essential causal action, and intended result/i);
  assert.match(value, /condense or merge secondary detail/i);
  assert.match(value, /Do not cram every minor action into the render/i);
  assert.match(value, /Explicit user duration instructions win/i);
  assert.match(value, /4-9 second result may use that shorter duration/i);
  assert.match(value, /otherwise 10 seconds is the minimum planning target/i);
  assert.match(value, /Never stretch a pose into a visibly frozen hold/i);
});

test('video system prompt enriches explicit and implicit diegetic sounds into one native-first blueprint', () => {
  const value = prompt();
  assert.match(value, /Perform an explicit diegetic-sound pass/i);
  assert.match(value, /Preserve every sound the user requests/i);
  assert.match(value, /Whether or not the user named sounds, infer a small, context-appropriate soundscape/i);
  assert.match(value, /dinosaur vocalization or body impact/i);
  assert.match(value, /moving car's engine and tires/i);
  assert.match(value, /visible dog's bark and cat's meow/i);
  assert.match(value, /Do not force every noun to make a sound/i);
  assert.match(value, /at most one useful continuous ambience plus a few important foreground sounds/i);
  assert.match(value, /simplify overlapping or crowded events into sequential, legible moments/i);
  assert.match(value, /`foleyCues` list as one shared sound blueprint/i);
  assert.match(value, /tells Agnes which synchronized native production sounds to render/i);
  assert.match(value, /exact ElevenLabs fallback plan/i);
  assert.match(value, /Keep this cue sheet even when Agnes is expected to supply all sound/i);
});

test('video system prompt gives Agnes sparse, broad, achievable choreography', () => {
  const value = prompt();
  assert.match(value, /Normally use two to four broad timeline beats/i);
  assert.match(value, /one dominant visual action per beat/i);
  assert.match(value, /4-8 second render, normally plan one or two foreground actions/i);
  assert.match(value, /9-12 second render, normally plan two or three and never more than four/i);
  assert.match(value, /anticipation, one readable action, then a visible consequence or settling pose/i);
  assert.match(value, /generous visual window, normally 1\.5-3\.0 seconds/i);
  assert.match(value, /single unmistakable peak near the middle of the window/i);
  assert.match(value, /distinct synchronized transients normally at least 1\.5 seconds apart/i);
  assert.match(value, /one continuous camera move, or a static camera/i);
  assert.match(value, /express broad ranges first/i);
  assert.match(value, /exact `atSeconds` is the intended peak inside that range/i);
});

test('video system prompt ties visible causes to global, sample-addressable Foley cues', () => {
  const value = prompt();
  assert.match(value, /global `foleyCues` list as one shared sound blueprint/i);
  assert.match(value, /Put each retained cue at its final-video-relative `atSeconds`/i);
  assert.match(value, /copy `\[<atSeconds with two decimals>s\] <visualAction>` verbatim/i);
  assert.match(value, /visible cause and its sound must share one timestamp/i);
  assert.match(value, /must end by the final duration/i);
  assert.match(value, /at least 0\.20 seconds away from the beginning and end/i);
  assert.match(value, /bat-contact crack belongs at the exact contact timestamp/i);
  assert.match(value, /crowd roar begins when the successful boundary is visibly established/i);
  assert.match(value, /roar cue occurs when jaws visibly open/i);
  assert.match(value, /local fallback audio placement is sample-exact/i);
  assert.match(value, /timing is generative and therefore best-effort/i);
});

test('video system prompt keeps Foley sparse, audible, literal, and visibly justified', () => {
  const value = prompt();
  assert.match(value, /conservative cue sheet, not an exhaustive inventory/i);
  assert.match(value, /at most one non-continuous `must_sync` cue per broad beat/i);
  assert.match(value, /no more than three foreground transients in a 4-8 second render/i);
  assert.match(value, /four in a 9-12 second render/i);
  assert.match(value, /literal physical or vocal event, not a metaphor/i);
  assert.match(value, /large or close enough that the sound would plausibly be heard/i);
  assert.match(value, /impact names both visible contacting subjects or materials/i);
  assert.match(value, /movement whoosh requires clearly fast, substantial motion/i);
  assert.match(value, /If the cause is uncertain, visually absent, inaudible at the depicted distance.*omit it/i);
  assert.match(value, /silence is preferable to an invented effect/i);
  assert.match(value, /Never create Foley for camera motion, cuts, zooms, light changes/i);
  assert.match(value, /an imaginary opponent or object/i);
});

test('video system prompt separates immediate-onset Foley from restrained optional music', () => {
  const value = prompt();
  assert.match(value, /Agnes native audio is the primary diegetic soundtrack/i);
  assert.match(value, /When it does, preserve that synchronized source audio and do not call ElevenLabs/i);
  assert.match(value, /Only when the Agnes source lacks usable audio/i);
  assert.match(value, /isolated immediate-onset ElevenLabs sound/i);
  assert.match(value, /inserts exact digital silence/i);
  assert.match(value, /Never ask ElevenLabs to generate leading silence/i);
  assert.match(value, /under 450 characters/i);
  assert.match(value, /literal source and motion\/contact/i);
  assert.match(value, /materials or surface, acoustic environment and camera distance/i);
  assert.match(value, /desired attack and natural decay/i);
  assert.match(value, /confusable sounds to exclude/i);
  assert.match(value, /Prefer naturalistic wording/i);
  assert.match(value, /Background music is requested by default/i);
  assert.match(value, /instrumental, restrained, low-level/i);
  assert.match(value, /explicitly requests no background music, Foley only, or sound effects only/i);
  assert.match(value, /`music\.enabled=false`, skip the music tool, and retain Foley/i);
  assert.match(value, /preserve explicit genre, BPM, and instrument choices/i);
  assert.match(value, /30-300 BPM/i);
  assert.match(value, /Design music only after the creative script and visual arc are settled/i);
  assert.match(value, /subject, action, stakes, atmosphere, and payoff/i);
  assert.match(value, /Fighting\/action should normally feel controlled, urgent, and forceful/i);
  assert.match(value, /chase or thriller should build tension and suspense/i);
  assert.match(value, /romance should feel warm, tender, and intimate/i);
  assert.match(value, /horror should feel ominous, uneasy, and dark/i);
  assert.match(value, /peaceful nature or reflection should feel calm and soothing/i);
  assert.match(value, /Emotional words in the user's story/i);
  assert.match(value, /do not make a high-stakes scene emotionally bland merely to keep it quiet/i);
  assert.match(value, /selected BPM as the perceived primary pulse, never a double-time suggestion/i);
  assert.match(value, /no rapid subdivisions, busy percussion, fast repeated notes, dense ostinatos, or arpeggios/i);
  assert.match(value, /Music beat windows describe broad phrase and texture changes only/i);
  assert.match(value, /diegetic soundtrack owns action transients/i);
  assert.match(value, /Free\.ai ACE-Step receives the complete narrative context/i);
  assert.match(value, /explicitly instrumental\/no-vocals instruction/i);
  assert.match(value, /4-9 second plans generate 10 seconds and local assembly trims the unused tail/i);
  assert.match(value, /Music must contain no speech, lyrics, creature calls, engines, rain, impacts, crowd noise/i);
});

test('video system prompt exposes global styles, aspect ratios, camera motion, and negative controls', () => {
  const value = prompt();
  assert.match(value, /Supported aspect ratios are `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, and `9:16`/i);
  assert.match(value, /exact user choices win/i);
  assert.match(value, /Agnes Flash is fixed at 720P tier/i);
  assert.match(value, /Supported visual-style vocabulary is `cinematic`, `animation`/i);
  assert.match(value, /Select one canonical camera motion/i);
  assert.match(value, /`slow pan left`/);
  assert.match(value, /`dolly forward`/);
  assert.match(value, /Preserve a clearly labeled user negative prompt in the continuity bible/i);
  assert.match(value, /Agnes has no separate style, camera-motion, or negative-prompt fields/i);
  assert.match(value, /composes those controls into the single ordinary prompt/i);
});

test('video system prompt enforces one asynchronous Agnes submission and receipt-based resume', () => {
  const value = prompt();
  assert.match(value, /call `generate_video` once when the source video is missing/i);
  assert.match(value, /submits one Agnes task or resumes its persisted `video_id`/i);
  assert.match(value, /polls every 30 seconds for no more than eight minutes/i);
  assert.match(value, /If the video tool returns `status=pending`, stop all media tool calls/i);
  assert.match(value, /never submit a replacement while a receipt exists/i);
  assert.match(value, /receipt binds its `video_id` to the exact key fingerprint that submitted it/i);
  assert.match(value, /Poll only with that key; never rotate an already accepted task/i);
  assert.match(value, /Local run-ID-scoped files are the only workflow state/i);
  assert.match(value, /exact run must be continued with its host-provided `--resume <run-id>` command/i);
  assert.match(value, /Repeating the prompt starts an independent run/i);
});

test('video system prompt orders full-timeline audio, assembly validation, reuse, and cleanup safely', () => {
  const value = prompt();
  assert.ok(value.indexOf('generate_foley_track') < value.indexOf('generate_music_track'));
  assert.match(value, /resolve the diegetic soundtrack/i);
  assert.match(value, /first inspects the downloaded Agnes audio/i);
  assert.match(value, /Usable source audio is preserved as the full-timeline diegetic stem/i);
  assert.match(value, /Only when source audio is missing or unusable/i);
  assert.match(value, /timestamped coarse\/fine vision inspection/i);
  assert.match(value, /retime supported fallback cues, omit absent or uncertain causes/i);
  assert.match(value, /source-audio decision, observed cue map, and per-cue assets are reused after interruption/i);
  assert.match(value, /zero fallback cues produces exact digital silence/i);
  assert.match(value, /audio-only `FREE_AI_API_AUDIO_KEY_n` pool/i);
  assert.match(value, /initial request plus three retries for any API\/provider error/i);
  assert.match(value, /moving to the next numbered key on each generation retry/i);
  assert.match(value, /successful music URL is persisted before download/i);
  assert.match(value, /If the tool returns `status=skipped`, the omission is durable/i);
  assert.match(value, /continue immediately with the selected diegetic soundtrack only/i);
  assert.match(value, /Assembly mixes either preserved Agnes audio or deterministic fallback Foley/i);
  assert.match(value, /with the quiet score when available/i);
  assert.match(value, /FFprobe validation of exact duration/i);
  assert.match(value, /one H\.264 video stream, and one AAC 48kHz stereo stream/i);
  assert.match(value, /Keep intermediate artifacts by default/i);
  assert.match(value, /Cleanup is permitted only when trusted prompt-derived configuration explicitly authorizes cleanup/i);
  assert.match(value, /Only `status=stored` or `status=reused` unlocks generation/i);
  assert.match(value, /rejected response is planner feedback/i);
});

test('video system prompt requires generated YouTube metadata when upload is requested', () => {
  const value = createVideoSystemPrompt({
    tools: {
      validatePlan: 'validate_video_plan',
      generateVideo: 'generate_video',
      generateMusic: 'generate_music_track',
      generateFoley: 'generate_foley_track',
      assembleVideo: 'assemble_final_video',
      youtubeUpload: 'upload_final_video_to_youtube',
    },
    youtubeUploadRequested: true,
    youtubeUploadAuthorized: true,
  });
  assert.match(value, /Generate accurate title, description, tags, and category metadata/i);
  assert.match(value, /5-12 specific unique tags/i);
  assert.match(value, /`24` Entertainment/i);
  assert.match(value, /exact trusted runtime values for privacy and made-for-kids status/i);
  assert.match(value, /upload only the validated final MP4/i);
});
