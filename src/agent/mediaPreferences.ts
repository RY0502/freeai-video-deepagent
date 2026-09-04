export type VideoAspectRatio = '21:9' | '16:9' | '4:3' | '1:1' | '3:4' | '9:16';
export type VideoVisualStyle =
  | 'cinematic'
  | 'animation'
  | 'realistic'
  | 'artistic'
  | 'vintage'
  | 'anime'
  | 'film-noir'
  | 'documentary'
  | 'commercial'
  | 'music-video';
export type VideoCameraMotion =
  | 'static'
  | 'slow pan left'
  | 'slow pan right'
  | 'slow tilt up'
  | 'slow tilt down'
  | 'slow zoom in'
  | 'slow zoom out'
  | 'slow orbit around'
  | 'handheld shaky'
  | 'dolly forward'
  | 'crane up';

/** Visual-style vocabulary composed into Agnes's ordinary prompt field. */
export const DOCUMENTED_VIDEO_STYLE_SUGGESTIONS = [
  'cinematic',
  'animation',
  'realistic',
  'artistic',
  'vintage',
  'anime',
  'film-noir',
  'documentary',
  'commercial',
  'music-video',
] as const satisfies readonly VideoVisualStyle[];

/** Exact aspect-ratio payload values documented for Agnes Video 2.5 Flash. */
export const DOCUMENTED_ASPECT_RATIO_SUGGESTIONS = [
  '21:9',
  '16:9',
  '4:3',
  '1:1',
  '3:4',
  '9:16',
] as const satisfies readonly VideoAspectRatio[];

/** Camera-language suggestions composed into Agnes's ordinary prompt field. */
export const DOCUMENTED_CAMERA_MOTION_SUGGESTIONS = [
  'static',
  'slow pan left',
  'slow pan right',
  'slow tilt up',
  'slow tilt down',
  'slow zoom in',
  'slow zoom out',
  'slow orbit around',
  'handheld shaky',
  'dolly forward',
  'crane up',
] as const satisfies readonly VideoCameraMotion[];

/** Conservative starting point when the user did not supply exclusions. */
export const DOCUMENTED_NEGATIVE_PROMPT_SUGGESTION =
  'blurry, low quality, distorted, extra fingers, watermark, text overlay, logo';

/** Non-exhaustive genre vocabulary suitable for Free.ai ACE-Step prompts. */
export const DOCUMENTED_MUSIC_GENRE_SUGGESTIONS = [
  'pop',
  'rock',
  'jazz',
  'electronic',
  'hip-hop',
  'rnb',
  'classical',
  'country',
  'reggae',
  'metal',
  'ambient',
  'lo-fi',
  'latin',
  'afrobeat',
] as const;

/** Instrument suggestions composed into the Free.ai ACE-Step prompt. */
export const DOCUMENTED_FEATURED_INSTRUMENT_SUGGESTIONS = [
  'piano',
  'acoustic guitar',
  'electric guitar',
  'saxophone',
  'violin',
  'synth',
  '808s',
  'flute',
  'harp',
  'drums',
] as const;

// Short aliases make the option lists convenient for prompts, logs, and callers.
export const VIDEO_STYLE_SUGGESTIONS = DOCUMENTED_VIDEO_STYLE_SUGGESTIONS;
export const ASPECT_RATIO_SUGGESTIONS = DOCUMENTED_ASPECT_RATIO_SUGGESTIONS;
export const CAMERA_MOTION_SUGGESTIONS = DOCUMENTED_CAMERA_MOTION_SUGGESTIONS;
export const MUSIC_GENRE_SUGGESTIONS = DOCUMENTED_MUSIC_GENRE_SUGGESTIONS;
export const FEATURED_INSTRUMENT_SUGGESTIONS = DOCUMENTED_FEATURED_INSTRUMENT_SUGGESTIONS;

export interface PromptMediaPreferenceDefaults {
  video: {
    style: VideoVisualStyle;
    aspectRatio: VideoAspectRatio;
    fps: number;
  };
}

export interface ResolvedVideoPreferences {
  style: VideoVisualStyle;
  aspectRatio: VideoAspectRatio;
  width: number;
  height: number;
  fps: number;
  styleSource: 'prompt' | 'default';
  aspectRatioSource: 'prompt' | 'default';
  /** Undefined means the planning agent may choose independently per scene. */
  cameraMotion?: VideoCameraMotion;
  cameraMotionSource: 'prompt' | 'agent';
  /** Clearly labeled user exclusions; otherwise the agent authors the negative bible. */
  negativePrompt?: string;
  negativePromptSource: 'prompt' | 'agent';
}

export interface ResolvedMusicPreferences {
  genre?: string;
  tempoBpm?: number;
  featuredInstrument?: string;
}

export interface ResolvedBackgroundMusicPreference {
  /** False only when the prompt contains an unambiguous, global music denial. */
  enabled: boolean;
  source: 'prompt' | 'default';
}

export interface ResolvedPromptMediaPreferences {
  video: ResolvedVideoPreferences;
  /** Whether the final mix should contain a generated background-music layer. */
  backgroundMusic: ResolvedBackgroundMusicPreference;
  /** Undefined means the planning agent should select suitable music settings. */
  music?: ResolvedMusicPreferences;
  /** False unless the prompt explicitly requests cleanup after successful completion. */
  cleanupAfterSuccess: boolean;
}

interface LocatedValue<T> {
  index: number;
  value: T;
}

type VideoDimensionsInput = {
  aspectRatio: VideoAspectRatio;
};

/** Fixed 720P-tier output dimensions documented for Agnes Video 2.5 Flash. */
export function resolveVideoDimensionsForAspectRatio(
  input: VideoDimensionsInput,
): { width: number; height: number };
export function resolveVideoDimensionsForAspectRatio(
  aspectRatio: VideoAspectRatio,
): { width: number; height: number };
export function resolveVideoDimensionsForAspectRatio(
  inputOrAspectRatio: VideoDimensionsInput | VideoAspectRatio,
): { width: number; height: number } {
  const aspectRatio = typeof inputOrAspectRatio === 'string'
    ? inputOrAspectRatio
    : inputOrAspectRatio.aspectRatio;
  const dimensions: Record<VideoAspectRatio, { width: number; height: number }> = {
    '21:9': { width: 1680, height: 720 },
    // Agnes's Flash documentation says generated 16:9 files are currently 1280x704.
    '16:9': { width: 1280, height: 704 },
    '4:3': { width: 960, height: 720 },
    '1:1': { width: 720, height: 720 },
    '3:4': { width: 720, height: 960 },
    '9:16': { width: 720, height: 1280 },
  };
  return dimensions[aspectRatio];
}

function normalizedPrompt(originalPrompt: string): string {
  return originalPrompt
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function allMatches<T>(
  prompt: string,
  pattern: RegExp,
  value: T,
): LocatedValue<T>[] {
  return Array.from(prompt.matchAll(pattern), (match) => ({
    index: match.index,
    value,
  }));
}

function lastLocated<T>(values: readonly LocatedValue<T>[]): T | undefined {
  let selected: LocatedValue<T> | undefined;
  for (const value of values) {
    if (selected === undefined || value.index >= selected.index) selected = value;
  }
  return selected?.value;
}

function uniqueLocatedText(values: readonly LocatedValue<string>[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const located of [...values].sort((left, right) => left.index - right.index)) {
    const fingerprint = located.value.toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
    if (!fingerprint || seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    result.push(located.value);
  }
  return result;
}

const AUDIO_NOUN = '(?:background\\s+)?(?:music|soundtrack|score|track|instrumental|song)';
const VIDEO_STYLE_ALIAS = '(?:cinematic|animation|animated|realistic|photorealistic|artistic|vintage|anime|film[ -]noir|documentary|commercial|music[ -]video)';

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isDelimitedOption(prompt: string, index: number, length: number): boolean {
  const before = prompt.slice(0, index).trimEnd();
  const after = prompt.slice(index + length).trimStart();
  return (before.length === 0 || /[,;]$/.test(before))
    && (after.length === 0 || /^[,;]/.test(after));
}

function isAudioQualifiedStyle(prompt: string, index: number, length: number): boolean {
  const before = prompt.slice(Math.max(0, index - 32), index);
  const following = prompt.slice(index + length, index + length + 36);
  return new RegExp(`${AUDIO_NOUN}[^.!?;,]{0,24}$`).test(before)
    || new RegExp(`^[^.!?;,]{0,24}${AUDIO_NOUN}\\b`).test(following);
}

function hasNearbyVisualIntent(prompt: string, index: number, length: number): boolean {
  const following = prompt.slice(index + length, index + length + 72).split(/[.!?;,]/, 1)[0] ?? '';
  const visualIndex = following.search(/\b(?:visuals?|video|clip|render(?:ing)?)\b/);
  if (visualIndex < 0) return false;
  const audioIndex = following.search(/\b(?:audio|sound(?:\s+design)?|music|soundtrack|score|instrumental|song)\b/);
  return audioIndex < 0 || visualIndex < audioIndex;
}

function resolveExplicitVideoStyle(prompt: string): VideoVisualStyle | undefined {
  const aliases: ReadonlyArray<readonly [VideoVisualStyle, string]> = [
    ['realistic', 'photo(?:realistic|[ -]realistic)'],
    ['animation', '(?:2d\\s+|3d\\s+)?animation|animated|cartoon(?:ish)?'],
    ['cinematic', 'cinematic|film[ -]like'],
    ['realistic', 'realistic'],
    ['artistic', 'artistic|painterly'],
    ['vintage', 'vintage|retro|(?:8mm|super[ -]8)'],
    ['anime', 'anime'],
    ['film-noir', 'film[ -]noir|noir'],
    ['documentary', 'documentary'],
    ['commercial', 'commercial'],
    ['music-video', 'music[ -]video'],
  ];
  const standalonePresets = new Set<VideoVisualStyle>([
    'animation',
    'anime',
    'film-noir',
    'documentary',
    'commercial',
    'music-video',
  ]);
  const matches: LocatedValue<VideoVisualStyle>[] = [];

  for (const [style, alias] of aliases) {
    const explicitPatterns = [
      new RegExp(`\\b(?:visual|video|render(?:ing)?|look|aesthetic)\\s+(?:style\\s+|preset\\s+)?(?:is\\s+)?(?:${alias})\\b`, 'g'),
      new RegExp(`\\b(?:${alias})\\s+(?:visuals?|video|style|preset|look|aesthetic|render(?:ing)?)\\b`, 'g'),
      new RegExp(`\\b(?:visual\\s+|video\\s+)?(?:style|preset)\\s*(?:is|:|=|-)?\\s*(?:${alias})\\b`, 'g'),
      new RegExp(`\\bin\\s+(?:a|an|the)?\\s*(?:${alias})\\s+style\\b`, 'g'),
      new RegExp(`\\bmake\\s+(?:it|the\\s+(?:video|visuals?))\\s+(?:look\\s+)?(?:${alias})\\b`, 'g'),
      new RegExp(`\\b(?:${alias})\\s+(?:21\\s*(?::|\\/|x|×|by)\\s*9|16\\s*(?::|\\/|x|×|by)\\s*9|4\\s*(?::|\\/|x|×|by)\\s*3|1\\s*(?::|\\/|x|×|by)\\s*1|3\\s*(?::|\\/|x|×|by)\\s*4|9\\s*(?::|\\/|x|×|by)\\s*16)(?!\\d)`, 'g'),
    ];
    for (const pattern of explicitPatterns) matches.push(...allMatches(prompt, pattern, style));

    for (const match of prompt.matchAll(new RegExp(`\\b(?:${alias})\\b`, 'g'))) {
      // Natural wording such as "a realistic dinosaur crossing a river in a
      // short video" carries visual intent, while "realistic sound design"
      // does not.
      if (hasNearbyVisualIntent(prompt, match.index, match[0].length)) {
        matches.push({ index: match.index, value: style });
        continue;
      }
      if (isDelimitedOption(prompt, match.index, match[0].length)) {
        matches.push({ index: match.index, value: style });
        continue;
      }
      const mayStandAlone = standalonePresets.has(style) || alias.startsWith('photo');
      if (mayStandAlone && !isAudioQualifiedStyle(prompt, match.index, match[0].length)) {
        matches.push({ index: match.index, value: style });
      }
    }

    // Cinematic is a common standalone visual request, but cinematic
    // orchestral music/action score is an audio request, not a video preset.
    if (style === 'cinematic') {
      for (const match of prompt.matchAll(/\bcinematic\b/g)) {
        if (!isAudioQualifiedStyle(prompt, match.index, match[0].length)) {
          matches.push({ index: match.index, value: style });
        }
      }
    }
  }

  return lastLocated(matches);
}

function resolveExplicitAspectRatio(prompt: string): VideoAspectRatio | undefined {
  const matches: LocatedValue<VideoAspectRatio>[] = [];
  const exactRatios: ReadonlyArray<readonly [VideoAspectRatio, string]> = [
    ['21:9', '21\\s*(?::|\\/|x|×|by)\\s*9'],
    ['16:9', '16\\s*(?::|\\/|x|×|by)\\s*9'],
    ['4:3', '4\\s*(?::|\\/|x|×|by)\\s*3'],
    ['1:1', '1\\s*(?::|\\/|x|×|by)\\s*1'],
    ['3:4', '3\\s*(?::|\\/|x|×|by)\\s*4'],
    ['9:16', '9\\s*(?::|\\/|x|×|by)\\s*16'],
  ];
  for (const [ratio, ratioPattern] of exactRatios) {
    const patterns = [
      new RegExp(`\\b(?:aspect(?:\\s+ratio)?|ratio|format|orientation)\\s*(?:is|:|=|-)?\\s*(?:${ratioPattern})(?!\\d)`, 'g'),
      new RegExp(`\\b(?:use|choose|select)\\s+(?:${ratioPattern})(?!\\d)`, 'g'),
      new RegExp(`\\b(?:render|output|export)\\s+(?:at|in|as)\\s+(?:${ratioPattern})(?!\\d)`, 'g'),
      new RegExp(`\\b(?:make|set)\\s+(?:it|the\\s+(?:video|clip|output))\\s*(?:to|at|in|as)?\\s*(?:${ratioPattern})(?!\\d)`, 'g'),
      new RegExp(`(?<!\\d)(?:${ratioPattern})\\s+(?:aspect(?:\\s+ratio)?|format|video|clip|output)\\b`, 'g'),
      new RegExp(`\\b${VIDEO_STYLE_ALIAS}\\s+(?:in\\s+)?(?:${ratioPattern})(?!\\d)`, 'g'),
    ];
    for (const pattern of patterns) matches.push(...allMatches(prompt, pattern, ratio));
    for (const match of prompt.matchAll(new RegExp(`(?<!\\d)(?:${ratioPattern})(?!\\d)`, 'g'))) {
      if (isDelimitedOption(prompt, match.index, match[0].length)) {
        matches.push({ index: match.index, value: ratio });
      }
    }
  }

  const namedRatios: ReadonlyArray<readonly [VideoAspectRatio, RegExp]> = [
    ['16:9', /\b(?:landscape|horizontal|widescreen)\s+(?:video|format|orientation|aspect(?:\s+ratio)?)\b/g],
    ['16:9', /\b(?:video|format|orientation|aspect(?:\s+ratio)?)\s*(?:is|:|=|in)?\s*(?:landscape|horizontal|widescreen)\b/g],
    ['9:16', /\b(?:portrait|vertical)\s+(?:video|format|orientation|aspect(?:\s+ratio)?)\b/g],
    ['9:16', /\b(?:video|format|orientation|aspect(?:\s+ratio)?)\s*(?:is|:|=|in)?\s*(?:portrait|vertical)\b/g],
    ['1:1', /\bsquare\s+(?:video|format|orientation|aspect(?:\s+ratio)?)\b/g],
    ['1:1', /\b(?:video|format|orientation|aspect(?:\s+ratio)?)\s*(?:is|:|=|in)?\s*square\b/g],
    ['3:4', /\bvertical\s+feed(?:\s+(?:video|format|orientation|aspect(?:\s+ratio)?))?\b/g],
    ['21:9', /\bultrawide\s+(?:video|format|orientation|aspect(?:\s+ratio)?)\b/g],
    ['21:9', /\b(?:video|format|orientation|aspect(?:\s+ratio)?)\s*(?:is|:|=|in)?\s*ultrawide\b/g],
    ['16:9', /\bmake\s+(?:it|the\s+video)\s+(?:landscape|horizontal|widescreen)\b/g],
    ['9:16', /\bmake\s+(?:it|the\s+video)\s+(?:portrait|vertical)\b/g],
    ['1:1', /\bmake\s+(?:it|the\s+video)\s+square\b/g],
    ['3:4', /\bmake\s+(?:it|the\s+video)\s+(?:a\s+)?vertical\s+feed\b/g],
    ['21:9', /\bmake\s+(?:it|the\s+video)\s+ultrawide\b/g],
  ];
  for (const [ratio, pattern] of namedRatios) matches.push(...allMatches(prompt, pattern, ratio));

  return lastLocated(matches);
}

function sceneScopedVideoControl(prompt: string, index: number): boolean {
  const clauseStart = Math.max(
    prompt.lastIndexOf('.', index),
    prompt.lastIndexOf('!', index),
    prompt.lastIndexOf('?', index),
    prompt.lastIndexOf(';', index),
  ) + 1;
  const prefix = prompt.slice(clauseStart, index);
  return /\b(?:in|for|during|at)\s+(?:the\s+)?(?:scene|clip|shot)\s*(?:[1-5]|one|two|three|four|five|first|second|third|fourth|fifth)\b/.test(prefix);
}

function resolveExplicitCameraMotion(prompt: string): VideoCameraMotion | undefined {
  const choices: ReadonlyArray<readonly [VideoCameraMotion, readonly RegExp[]]> = [
    ['static', [
      /\b(?:camera\s+motion|camera)\s*(?:is|:|=|-)?\s*(?:static|fixed|locked(?:[- ]off)?|no\s+motion)\b/g,
      /\b(?:static|fixed|locked[- ]off)\s+camera\b/g,
      /\bno\s+camera\s+(?:motion|movement)\b/g,
    ]],
    ['slow pan left', [
      /\b(?:camera\s+motion|camera)\s*(?:is|:|=|-)?\s*(?:slow(?:ly)?\s+)?pan(?:s|ning)?\s+left\b/g,
      /\bcamera\s+(?:slowly\s+)?pans\s+left\b/g,
    ]],
    ['slow pan right', [
      /\b(?:camera\s+motion|camera)\s*(?:is|:|=|-)?\s*(?:slow(?:ly)?\s+)?pan(?:s|ning)?\s+right\b/g,
      /\bcamera\s+(?:slowly\s+)?pans\s+right\b/g,
    ]],
    ['slow tilt up', [
      /\b(?:camera\s+motion|camera)\s*(?:is|:|=|-)?\s*(?:slow(?:ly)?\s+)?tilt(?:s|ing)?\s+up\b/g,
      /\bcamera\s+(?:slowly\s+)?tilts\s+up\b/g,
    ]],
    ['slow tilt down', [
      /\b(?:camera\s+motion|camera)\s*(?:is|:|=|-)?\s*(?:slow(?:ly)?\s+)?tilt(?:s|ing)?\s+down\b/g,
      /\bcamera\s+(?:slowly\s+)?tilts\s+down\b/g,
    ]],
    ['slow zoom in', [
      /\b(?:camera\s+motion|camera)\s*(?:is|:|=|-)?\s*(?:slow(?:ly)?\s+)?zoom(?:s|ing)?\s+in\b/g,
      /\bcamera\s+(?:slowly\s+)?zooms\s+in\b/g,
    ]],
    ['slow zoom out', [
      /\b(?:camera\s+motion|camera)\s*(?:is|:|=|-)?\s*(?:slow(?:ly)?\s+)?zoom(?:s|ing)?\s+out\b/g,
      /\bcamera\s+(?:slowly\s+)?zooms\s+out\b/g,
    ]],
    ['slow orbit around', [
      /\b(?:camera\s+motion|camera)\s*(?:is|:|=|-)?\s*(?:slow(?:ly)?\s+)?orbit(?:s|ing)?(?:\s+around)?\b/g,
      /\bcamera\s+(?:slowly\s+)?orbits(?:\s+around)?\b/g,
    ]],
    ['handheld shaky', [
      /\b(?:camera\s+motion|camera)\s*(?:is|:|=|-)?\s*(?:handheld(?:\s+shaky)?|shaky\s+handheld)\b/g,
      /\bhandheld\s+(?:shaky\s+)?camera\b/g,
    ]],
    ['dolly forward', [
      /\b(?:camera\s+motion|camera)\s*(?:is|:|=|-)?\s*doll(?:y|ies|ying)\s+forward\b/g,
      /\bdolly\s+forward\s+(?:camera\s+)?motion\b/g,
    ]],
    ['crane up', [
      /\b(?:camera\s+motion|camera)\s*(?:is|:|=|-)?\s*crane(?:s|ing)?\s+up\b/g,
      /\bcrane\s+up\s+(?:camera\s+)?motion\b/g,
    ]],
  ];
  const matches: LocatedValue<VideoCameraMotion>[] = [];
  for (const [motion, patterns] of choices) {
    for (const pattern of patterns) {
      for (const match of prompt.matchAll(pattern)) {
        if (!sceneScopedVideoControl(prompt, match.index)) {
          matches.push({ index: match.index, value: motion });
        }
      }
    }
    for (const match of prompt.matchAll(new RegExp(`\\b${regexEscape(motion).replace(/ /g, '\\s+')}\\b`, 'g'))) {
      if (
        isDelimitedOption(prompt, match.index, match[0].length)
        && !sceneScopedVideoControl(prompt, match.index)
      ) {
        matches.push({ index: match.index, value: motion });
      }
    }
  }
  return lastLocated(matches);
}

function cleanNegativePromptControl(value: string): string | undefined {
  const cleaned = value
    .split(/[,;]\s*(?=(?:camera(?:\s+motion)?|negative\s+(?:prompt|constraints?|bible)|avoid|visual\s+style|style|aspect(?:\s+ratio)?|ratio|genre|tempo|bpm|featured\s+instrument)\s*(?:is|of|:|=|-))/i, 1)[0]
    ?.trim()
    .replace(/[,\s]+$/, '');
  return cleaned && cleaned.length <= 1_000 ? cleaned : undefined;
}

/** Only labeled controls are treated as global negative-prompt instructions. */
function resolveExplicitNegativePrompt(prompt: string): string | undefined {
  const matches: LocatedValue<string>[] = [];
  const patterns = [
    /\bnegative\s+(?:prompt|constraints?|bible)\s*(?:(?:is|of)\s+|[:=]\s*|-\s*)([^.!?\n]{1,1000})/g,
    /\bavoid\s*:\s*([^.!?\n]{1,1000})/g,
  ];
  for (const pattern of patterns) {
    for (const match of prompt.matchAll(pattern)) {
      const rawValue = match[1];
      if (!rawValue || sceneScopedVideoControl(prompt, match.index)) continue;
      const value = cleanNegativePromptControl(rawValue);
      if (value) matches.push({ index: match.index, value });
    }
  }
  const values = uniqueLocatedText(matches);
  return values.length > 0 ? values.join('; ') : undefined;
}

const GENRE_ALIASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['pop', ['pop']],
  ['rock', ['rock']],
  ['jazz', ['jazz']],
  ['electronic', ['electronic', 'edm']],
  ['hip-hop', ['hip-hop', 'hip hop']],
  ['rnb', ['rnb', 'r&b', 'r and b', 'rhythm and blues']],
  ['classical', ['classical']],
  ['country', ['country']],
  ['reggae', ['reggae']],
  ['metal', ['metal']],
  ['ambient', ['ambient']],
  ['lo-fi', ['lo-fi', 'lo fi', 'lofi']],
  ['latin', ['latin']],
  ['afrobeat', ['afrobeat', 'afro-beat']],
];

const INSTRUMENT_ALIASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['acoustic guitar', ['acoustic guitar']],
  ['electric guitar', ['electric guitar']],
  ['guitar', ['guitar']],
  ['piano', ['piano']],
  ['saxophone', ['saxophone', 'sax']],
  ['violin', ['violin']],
  ['synth', ['synth', 'synthesizer']],
  ['808s', ['808s', '808']],
  ['flute', ['flute']],
  ['harp', ['harp']],
  ['drums', ['drums', 'drum kit']],
];

function canonicalAlias(
  value: string,
  aliases: ReadonlyArray<readonly [string, readonly string[]]>,
): string | undefined {
  for (const [canonical, values] of aliases) {
    if (values.some((alias) => new RegExp(
      `^(?:${regexEscape(alias).replace(/ /g, '[ -]+')})$`,
    ).test(value))) return canonical;
  }
  return undefined;
}

function cleanControlValue(
  rawValue: string,
  kind: 'genre' | 'instrument',
): string | undefined {
  let value = rawValue
    .trim()
    .replace(/^(?:(?:use|choose|select|add|create|generate|with)\s+)?(?:(?:a|an|the|like)\s+)?/, '')
    .split(/\s+(?=(?:(?:and\s+)?(?:at\s+)?\d{2,3}\s*(?:bpm|beats\s+per\s+minute)|(?:and\s+)?(?:tempo|bpm|featured\s+instrument|instrument|featuring|with)\b))/)[0]
    ?.trim() ?? '';
  if (kind === 'genre') {
    value = value.replace(/\s+(?:(?:background\s+)?music|soundtrack|score|genre(?:\s+hint)?)$/, '');
    value = value.replace(/\s+(?:for|as)(?:\s+the)?$/, '');
  }
  value = value.replace(/\s+(?:and|at|with)$/, '').trim();
  const maximumWords = kind === 'genre' ? 6 : 5;
  if (
    value.length === 0
    || /^(?:a|an|the|like)$/.test(value)
    || value.length > 64
    || value.split(/\s+/).length > maximumWords
    || !/^[a-z0-9][a-z0-9&'+./ -]*$/.test(value)
  ) return undefined;
  return canonicalAlias(value, kind === 'genre' ? GENRE_ALIASES : INSTRUMENT_ALIASES) ?? value;
}

function labeledControlMatches(
  prompt: string,
  labelPattern: string,
  kind: 'genre' | 'instrument',
): LocatedValue<string>[] {
  const matches: LocatedValue<string>[] = [];
  const pattern = new RegExp(
    `\\b(?:${labelPattern})\\s*(?:(?:is|of)\\s+|[:=]\\s*|-\\s*|\\s+)(?:like\\s+)?([^,;.!?]{1,80})`,
    'g',
  );
  for (const match of prompt.matchAll(pattern)) {
    const rawValue = match[1];
    if (!rawValue) continue;
    const value = cleanControlValue(rawValue, kind);
    if (!value) continue;
    matches.push({
      index: match.index + match[0].indexOf(rawValue),
      value,
    });
  }
  return matches;
}

function compactAudioOptionContext(prompt: string): boolean {
  if (
    new RegExp(`\\b${AUDIO_NOUN}\\b`).test(prompt)
    || /\bgenre(?:\s+hint)?\b/.test(prompt)
    || /\bfeatured\s+instrument\b/.test(prompt)
    || /(?:^|[,;])\s*\d{2,3}\s*bpm\s*(?=$|[,;])/m.test(prompt)
  ) return true;

  const segments = prompt.split(/[,;]/).map((segment) => segment.trim());
  const hasGenre = segments.some((segment) => canonicalAlias(segment, GENRE_ALIASES));
  const hasInstrument = segments.some((segment) => canonicalAlias(segment, INSTRUMENT_ALIASES));
  return hasGenre && hasInstrument;
}

function compactAliasMatches(
  prompt: string,
  pattern: string,
  value: string,
): LocatedValue<string>[] {
  const matches: LocatedValue<string>[] = [];
  for (const match of prompt.matchAll(new RegExp(
    `(?:^|[,;])\\s*((?:${pattern}))\\s*(?=$|[,;])`,
    'g',
  ))) {
    const rawValue = match[1];
    if (!rawValue) continue;
    matches.push({
      index: match.index + match[0].indexOf(rawValue),
      value,
    });
  }
  return matches;
}

function resolveExplicitGenre(prompt: string): string | undefined {
  const matches = labeledControlMatches(prompt, 'genre(?:\\s+hint)?', 'genre');
  const allowCompact = compactAudioOptionContext(prompt);
  for (const [genre, aliases] of GENRE_ALIASES) {
    for (const literalAlias of aliases) {
      const alias = regexEscape(literalAlias).replace(/ /g, '\\s+');
      const patterns = [
        new RegExp(`\\bgenre(?:\\s+hint)?\\s*(?:is|:|=|-)?\\s*(?:${alias})\\b`, 'g'),
        new RegExp(`\\b(?:${alias})\\s+genre\\b`, 'g'),
        new RegExp(`\\b(?:${alias})\\s+${AUDIO_NOUN}\\b`, 'g'),
        new RegExp(`\\b${AUDIO_NOUN}\\s*(?:genre(?:\\s+hint)?\\s*)?(?:is|:|=|of|in)?\\s*(?:${alias})\\b`, 'g'),
        new RegExp(`\\b(?:use|choose|select)\\s+(?:${alias})\\s+(?:for|as)\\s+(?:the\\s+)?${AUDIO_NOUN}\\b`, 'g'),
      ];
      for (const pattern of patterns) matches.push(...allMatches(prompt, pattern, genre));
      if (allowCompact) matches.push(...compactAliasMatches(prompt, alias, genre));
    }
  }

  const freeFormPattern = /(?:^|[,;]\s*|\b(?:use|choose|select|add|with)\s+)((?:[a-z0-9&'+./-]+\s+){0,4}[a-z0-9&'+./-]+)\s+(?:background\s+)?(?:music|soundtrack|score)\b/g;
  for (const match of prompt.matchAll(freeFormPattern)) {
    const rawValue = match[1];
    if (!rawValue) continue;
    const value = cleanControlValue(rawValue, 'genre');
    if (!value) continue;
    if (/(?:^|[- ])(?:led|driven|focused)$/.test(value)) continue;
    matches.push({ index: match.index + match[0].indexOf(rawValue), value });
  }
  return lastLocated(matches);
}

function resolveExplicitTempo(prompt: string): number | undefined {
  const matches: LocatedValue<number>[] = [];
  const patterns = [
    /(?<!\d)(\d{2,3})\s*(?:bpm|beats\s+per\s+minute)\b/g,
    /\bbpm\s*(?:is|:|=|-)?\s*(\d{2,3})(?!\d)/g,
    /\b(?:music\s+)?tempo(?:\s*-?\s*bpm)?\s*(?:is|of|:|=|-)?\s*(\d{2,3})(?!\d)/g,
  ];
  for (const pattern of patterns) {
    for (const match of prompt.matchAll(pattern)) {
      const value = Number(match[1]);
      const localContext = prompt.slice(
        Math.max(0, match.index - 32),
        Math.min(prompt.length, match.index + match[0].length + 32),
      );
      if (/\b(?:heart\s+rate|pulse|cardiac|medical\s+monitor|monitor\s+reads?)\b/.test(localContext)) {
        continue;
      }
      if (Number.isInteger(value) && value >= 30 && value <= 300) {
        matches.push({ index: match.index, value });
      }
    }
  }
  return lastLocated(matches);
}

function resolveExplicitFeaturedInstrument(prompt: string): string | undefined {
  const matches = labeledControlMatches(prompt, 'featured\\s+instrument', 'instrument');
  const allowCompact = compactAudioOptionContext(prompt);
  for (const [instrument, aliases] of INSTRUMENT_ALIASES) {
    for (const literalAlias of aliases) {
      const alias = instrument === 'guitar'
        ? '(?<!acoustic[ -])(?<!electric[ -])guitar'
        : regexEscape(literalAlias).replace(/ /g, '[ -]+');
      const patterns = [
        new RegExp(`\\b(?:featured\\s+)?instrument\\s*(?:is|:|=|-)?\\s*(?:an?\\s+|the\\s+)?(?:${alias})\\b`, 'g'),
        new RegExp(`\\b(?:${alias})\\s+(?:as\\s+)?(?:the\\s+)?featured\\s+instrument\\b`, 'g'),
        new RegExp(`\\b${AUDIO_NOUN}[^.!?]{0,24}\\b(?:featuring|with|led\\s+by)\\s+(?:an?\\s+|the\\s+)?(?:${alias})\\b`, 'g'),
        new RegExp(`\\b(?:${alias})[ -](?:led|driven|focused)\\s+${AUDIO_NOUN}\\b`, 'g'),
        new RegExp(`\\b(?:${alias})\\s+${AUDIO_NOUN}\\b`, 'g'),
        new RegExp(`\\b(?:feature|use)\\s+(?:an?\\s+|the\\s+)?(?:${alias})\\s+(?:in|for)\\s+(?:the\\s+)?${AUDIO_NOUN}\\b`, 'g'),
      ];
      for (const pattern of patterns) matches.push(...allMatches(prompt, pattern, instrument));
      if (allowCompact) matches.push(...compactAliasMatches(prompt, alias, instrument));
    }
  }

  const freeFormPattern = new RegExp(
    `\\b${AUDIO_NOUN}\\b[^.!?;,]{0,24}\\b(?:featuring|led\\s+by)\\s+(?:an?\\s+|the\\s+)?([^,;.!?]{1,80})`,
    'g',
  );
  for (const match of prompt.matchAll(freeFormPattern)) {
    const rawValue = match[1];
    if (!rawValue) continue;
    const value = cleanControlValue(rawValue, 'instrument');
    if (!value) continue;
    matches.push({ index: match.index + match[0].indexOf(rawValue), value });
  }
  return lastLocated(matches);
}

function explicitlyDeniesCleanup(prompt: string): boolean {
  const artifactTarget = '(?:local\\s+)?(?:artifacts?|intermediates?|temporary\\s+(?:files?|assets?)|generated\\s+(?:files?|assets?)|source\\s+(?:files?|assets?)|media\\s+(?:files?|assets?))';
  const cleanupAction = '(?:clean\\s*up|cleanup|delete|remove|erase|purge)';
  const denialPatterns = [
    // Treat any nearby negation as authoritative, including wording such as
    // "do not automatically perform cleanup" and "no cleanup after success".
    new RegExp(`\\b(?:do\\s+not|don't|never)\\b[^.!?;]{0,48}\\b${cleanupAction}\\b`),
    new RegExp(`\\bno\\s+(?:automatic\\s+|post[- ]success\\s+)?${cleanupAction}\\b`),
    new RegExp(`\\b(?:keep|preserve|retain)\\b[^.!?]{0,32}\\b${artifactTarget}\\b`),
    /\bwithout\s+(?:post[- ]success\s+)?clean\s*up\b/,
  ];
  return denialPatterns.some((pattern) => pattern.test(prompt));
}

function explicitlyRequestsCleanupAfterSuccess(prompt: string): boolean {
  if (explicitlyDeniesCleanup(prompt)) return false;

  const cleanupAction = '(?:clean\\s*up|cleanup|delete|remove|erase|purge)';
  const artifactTarget = '(?:the\\s+)?(?:local\\s+)?(?:artifacts?|intermediates?|temporary\\s+(?:files?|assets?)|generated\\s+(?:files?|assets?)|source\\s+(?:files?|assets?)|media\\s+(?:files?|assets?))';
  const successPoint = '(?:after|once|when|upon|on|following)\\s+(?:the\\s+)?(?:(?:final\\s+)?video\\s+|media\\s+)?(?:is\\s+|has\\s+been\\s+)?(?:successfully\\s+generated|generated\\s+successfully|successful\\s+generation|successful\\s+completion|generation\\s+succeeds|completion|success)';
  // Destructive permission must be expressed as its own imperative clause. Do
  // not scan arbitrary narrative text for action words: a requested caption or
  // character dialogue can contain the same phrase without authorizing deletion.
  const imperativeStart = '(?:^|[.!?;]\\s*|,\\s+and\\s+|,\\s*(?:and\\s+)?then\\s+|\\s+and\\s+then\\s+)(?:(?:please|then|also)\\s+)*(?:perform\\s+)?';
  const postCreationSuccessStart = '(?:^|[.!?;]\\s*|,\\s*(?:and\\s+)?|\\s+and\\s+)';
  const positivePatterns = [
    new RegExp(`${imperativeStart}${cleanupAction}\\b[^.!?]{0,56}\\b${artifactTarget}\\b[^.!?]{0,64}\\b${successPoint}\\b`),
    new RegExp(`${postCreationSuccessStart}${successPoint}\\b[^.!?]{0,64}\\b(?:please\\s+)?(?:perform\\s+)?${cleanupAction}\\b[^.!?]{0,56}\\b${artifactTarget}\\b`),
    // Allow a targetless request only as a standalone imperative sentence.
    // This avoids treating narrative text such as "a robot cleans up after..."
    // as permission to delete the run artifacts.
    new RegExp(`${imperativeStart}${cleanupAction}\\s+after\\s+(?:successful\\s+)?(?:generation|completion|success)(?=$|[.!?;])`),
  ];
  return positivePatterns.some((pattern) => pattern.test(prompt));
}

const NON_LAYER_MUSIC_SUFFIX =
  '(?:box|video|festival|lesson|class|policy|sign|poster|note|label|text|room)';
const BACKGROUND_MUSIC_LAYER =
  `(?:background\\s+music|music\\s+bed|music(?![ -]${NON_LAYER_MUSIC_SUFFIX})|` +
  'soundtrack|background\\s+score|musical\\s+score|instrumental\\s+(?:music|bed))';

function directiveClause(prompt: string, index: number): {
  clause: string;
  matchIndex: number;
} {
  const before = prompt.slice(0, index);
  const boundary = Math.max(
    before.lastIndexOf('.'),
    before.lastIndexOf('!'),
    before.lastIndexOf('?'),
    before.lastIndexOf(';'),
    before.lastIndexOf('\n'),
  );
  const clauseStart = boundary + 1;
  const remaining = prompt.slice(index);
  const relativeEnd = remaining.search(/[.!?;\n]/);
  const clauseEnd = relativeEnd < 0 ? prompt.length : index + relativeEnd;
  return {
    clause: prompt.slice(clauseStart, clauseEnd),
    matchIndex: index - clauseStart,
  };
}

function isNarrativeMusicDirective(clause: string, matchIndex: number): boolean {
  const prefix = clause.slice(0, matchIndex);
  return [
    /\b(?:on[- ]screen\s+)?(?:text|caption|subtitle|sign|poster|banner|label|title)\b[^:]{0,40}(?:says?|reads?|shows?|displays?|:)\s*$/,
    /\b(?:character|person|actor|narrator|speaker|presenter)\b[^,]{0,32}\b(?:says?|shouts?|whispers?|mentions?)\s*,?\s*$/,
    /\b(?:words?|phrase|quotation|quote)\b[^:]{0,32}(?:is|are|says?|reads?|:)\s*$/,
  ].some((pattern) => pattern.test(prefix));
}

function isSceneScopedMusicDirective(
  clause: string,
  matchIndex: number,
  matchLength: number,
): boolean {
  const prefix = clause.slice(0, matchIndex);
  const suffix = clause.slice(matchIndex + matchLength);
  const scopedPrefix =
    /\b(?:at|in|during|for)\s+(?:scene|clip|shot)\s*(?:[1-9]|one|two|three|first|second|third)\b[^,]{0,20},?\s*(?:(?:please\s+)?(?:use|keep|make(?:\s+it)?|with)\s+)?$/;
  const namedSectionPrefix =
    /\b(?:at|in|during|for)\s+(?:the\s+)?(?:start|opening|beginning|middle|end|ending|finale|first|second|third)\b[^,]{0,20},?\s*(?:(?:please\s+)?(?:use|keep|make(?:\s+it)?|with)\s+)?$/;
  const scopedSuffix =
    /^\s+(?:until|before|after|during|while|when|at\s+(?:the\s+)?(?:start|beginning|opening|end|ending)|for\s+(?:the\s+)?(?:first|next|opening|final|\d+(?:\.\d+)?\s*(?:s|sec(?:ond)?s?))|in\s+(?:(?:scene|clip|shot)\b|(?:the\s+)?(?:first|second|third|opening|final)\b))/;
  return scopedPrefix.test(prefix)
    || namedSectionPrefix.test(prefix)
    || scopedSuffix.test(suffix);
}

/**
 * Conservatively recognizes a global request for a Foley/effects-only mix.
 * Scene-scoped instructions and quoted/on-screen narrative text are left to
 * the planner instead of disabling the complete background-music layer.
 */
export function promptExplicitlyDisablesBackgroundMusic(originalPrompt: string): boolean {
  const prompt = normalizedPrompt(originalPrompt);
  const patterns = [
    new RegExp(
      `\\b(?:no|without)\\s+(?:(?:any|the)\\s+)?${BACKGROUND_MUSIC_LAYER}\\b`,
      'g',
    ),
    new RegExp(
      `\\b(?:do\\s+not|don't|dont|never)\\s+` +
      `(?:add|include|use|generate|create|play|mix|overlay|provide|produce|have)\\b` +
      `[^.!?;]{0,40}\\b${BACKGROUND_MUSIC_LAYER}\\b`,
      'g',
    ),
    /\b(?:foley|sound\s+effects?|sfx|natural\s+sounds?)\s+only\b/g,
    /\bonly\s+(?:foley|sound\s+effects?|sfx|natural\s+sounds?)(?:\s+audio)?\b/g,
    /\b(?:no|without)\s+(?:(?:any|the)\s+)?background\s+(?:sounds?|audio)(?=$|[,/]|\s+(?:at\s+all\b|except\b|other\s+than\b|and\s+(?:use|keep|include)\b))/g,
  ];

  for (const pattern of patterns) {
    for (const match of prompt.matchAll(pattern)) {
      const located = directiveClause(prompt, match.index);
      if (isNarrativeMusicDirective(located.clause, located.matchIndex)) continue;
      if (isSceneScopedMusicDirective(located.clause, located.matchIndex, match[0].length)) continue;
      return true;
    }
  }
  return false;
}

/** Resolve only explicit prompt preferences, retaining configured video defaults. */
export function resolvePromptMediaPreferences(
  originalPrompt: string,
  defaults: PromptMediaPreferenceDefaults,
): ResolvedPromptMediaPreferences {
  const prompt = normalizedPrompt(originalPrompt);
  const explicitStyle = resolveExplicitVideoStyle(prompt);
  const explicitAspectRatio = resolveExplicitAspectRatio(prompt);
  const explicitCameraMotion = resolveExplicitCameraMotion(prompt);
  const explicitNegativePrompt = resolveExplicitNegativePrompt(prompt);
  const aspectRatio = explicitAspectRatio ?? defaults.video.aspectRatio;
  const dimensions = resolveVideoDimensionsForAspectRatio({
    aspectRatio,
  });
  const genre = resolveExplicitGenre(prompt);
  const tempoBpm = resolveExplicitTempo(prompt);
  const featuredInstrument = resolveExplicitFeaturedInstrument(prompt);
  const hasMusicPreference = genre !== undefined
    || tempoBpm !== undefined
    || featuredInstrument !== undefined;
  const backgroundMusicDisabled = promptExplicitlyDisablesBackgroundMusic(prompt);

  return {
    video: {
      style: explicitStyle ?? defaults.video.style,
      aspectRatio,
      ...dimensions,
      fps: defaults.video.fps,
      styleSource: explicitStyle === undefined ? 'default' : 'prompt',
      aspectRatioSource: explicitAspectRatio === undefined ? 'default' : 'prompt',
      ...(explicitCameraMotion === undefined ? {} : { cameraMotion: explicitCameraMotion }),
      cameraMotionSource: explicitCameraMotion === undefined ? 'agent' : 'prompt',
      ...(explicitNegativePrompt === undefined ? {} : { negativePrompt: explicitNegativePrompt }),
      negativePromptSource: explicitNegativePrompt === undefined ? 'agent' : 'prompt',
    },
    backgroundMusic: {
      enabled: !backgroundMusicDisabled,
      source: backgroundMusicDisabled ? 'prompt' : 'default',
    },
    ...(hasMusicPreference
      ? {
          music: {
            ...(genre === undefined ? {} : { genre }),
            ...(tempoBpm === undefined ? {} : { tempoBpm }),
            ...(featuredInstrument === undefined ? {} : { featuredInstrument }),
          },
        }
      : {}),
    cleanupAfterSuccess: explicitlyRequestsCleanupAfterSuccess(prompt),
  };
}
