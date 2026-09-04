import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  DeepAgentRunner,
  type DeepAgentRunnerOptions,
  type RunResult,
} from 'freetier-deepagent-framework';
import { LocalFrameworkDatabase } from '../state/localFrameworkDatabase.js';
import { VideoRunStateStore } from '../state/videoRunState.js';
import { createValidateVideoPlanTool } from './planTool.js';
import { scopeFrameworkFilesystemToRunDirectory } from './scopedFilesystemBackend.js';
import { createVideoSystemPrompt } from './systemPrompt.js';
import { promptExplicitlyRequestsYouTubeUpload } from './videoPlan.js';

export interface VideoAgentTools {
  /** Preferred prompt-aware validator supplied by the host application. */
  validatePlan?: DynamicStructuredTool;
  generateVideo: DynamicStructuredTool;
  generateMusic: DynamicStructuredTool;
  generateFoley: DynamicStructuredTool;
  assembleVideo: DynamicStructuredTool;
  additionalTools?: DynamicStructuredTool[];
  youtubeUploadToolFactory?: YouTubeUploadToolFactory;
}

export interface YouTubeUploadAuthorization {
  /** Must come from trusted application state, never from model tool arguments. */
  approved: true;
  /** Binds this approval to one normalized user prompt. */
  promptHash: string;
  /** Opaque one-run token consumed by the external upload-tool factory. */
  token: string;
}

export interface AuthorizedYouTubeToolContext {
  originalPrompt: string;
  promptHash: string;
  authorization: Readonly<YouTubeUploadAuthorization>;
}

export type YouTubeUploadToolFactory = (
  context: AuthorizedYouTubeToolContext,
) => DynamicStructuredTool | Promise<DynamicStructuredTool>;

export interface VideoAgentInvocationOptions {
  youtubeAuthorization?: YouTubeUploadAuthorization;
}

export interface VideoAgentRunResult extends RunResult {
  youtubeUploadRequested: boolean;
  youtubeUploadAuthorized: boolean;
}

export interface CreateVideoAgentRunnerOptions {
  runDirectory: string;
  stateStore?: VideoRunStateStore;
  frameworkDatabase?: LocalFrameworkDatabase;
  tools: VideoAgentTools;
  frameworkOptions?: Omit<DeepAgentRunnerOptions, 'extraTools' | 'systemPromptExtension'>;
  additionalSystemRules?: string;
}

export interface VideoAgentRunner {
  readonly state: VideoRunStateStore;
  run(originalPrompt: string, options?: VideoAgentInvocationOptions): Promise<VideoAgentRunResult>;
}

const YouTubeUploadAuthorizationSchema = z.object({
  approved: z.literal(true),
  promptHash: z.string().regex(/^[a-f0-9]{64}$/),
  token: z.string().trim().min(16),
}).strict();

export class YouTubeUploadAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YouTubeUploadAuthorizationError';
  }
}

interface NamedAgentTool {
  name: string;
}

function looksLikeYouTubeUploadTool(tool: NamedAgentTool): boolean {
  const normalized = tool.name.toLowerCase();
  return normalized.includes('youtube')
    && (normalized.includes('upload') || normalized.includes('publish') || normalized.includes('post'));
}

function assertUniqueToolNames(tools: readonly NamedAgentTool[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error(`Duplicate agent tool name: ${tool.name}`);
    }
    names.add(tool.name);
  }
}

class DefaultVideoAgentRunner implements VideoAgentRunner {
  readonly state: VideoRunStateStore;
  readonly #frameworkDatabase: LocalFrameworkDatabase | undefined;

  constructor(private readonly options: CreateVideoAgentRunnerOptions) {
    this.state = options.stateStore ?? new VideoRunStateStore(options.runDirectory);
    this.#frameworkDatabase = options.frameworkDatabase;
    const callerTools = [
      options.tools.generateVideo,
      options.tools.generateFoley,
      options.tools.generateMusic,
      options.tools.assembleVideo,
      ...(options.tools.additionalTools ?? []),
    ];
    const hiddenUpload = callerTools.find(looksLikeYouTubeUploadTool);
    if (hiddenUpload) {
      throw new Error(
        `YouTube-like tool ${hiddenUpload.name} must be supplied through youtubeUploadToolFactory so runtime authorization cannot be bypassed.`,
      );
    }
    assertUniqueToolNames(callerTools);
  }

  async run(
    originalPrompt: string,
    invocationOptions: VideoAgentInvocationOptions = {},
  ): Promise<VideoAgentRunResult> {
    if (!originalPrompt.trim()) throw new Error('A non-empty video prompt is required.');

    const promptHash = this.state.promptHash(originalPrompt);
    const uploadRequested = promptExplicitlyRequestsYouTubeUpload(originalPrompt);
    let uploadTool: DynamicStructuredTool | undefined;

    if (invocationOptions.youtubeAuthorization) {
      const authorization = YouTubeUploadAuthorizationSchema.parse(invocationOptions.youtubeAuthorization);
      if (!uploadRequested) {
        throw new YouTubeUploadAuthorizationError(
          'YouTube authorization was supplied, but the original prompt does not explicitly request an upload.',
        );
      }
      if (authorization.promptHash !== promptHash) {
        throw new YouTubeUploadAuthorizationError(
          'YouTube authorization is bound to a different prompt hash.',
        );
      }
      if (!this.options.tools.youtubeUploadToolFactory) {
        throw new YouTubeUploadAuthorizationError(
          'YouTube authorization was supplied, but no authorized upload-tool factory is configured.',
        );
      }
      uploadTool = await this.options.tools.youtubeUploadToolFactory({
        originalPrompt,
        promptHash,
        authorization,
      });
      if (!looksLikeYouTubeUploadTool(uploadTool)) {
        throw new Error(
          `Authorized upload tool must have an unambiguous YouTube upload/publish name; received ${uploadTool.name}.`,
        );
      }
    }

    const validatePlanTool = this.options.tools.validatePlan
      ?? createValidateVideoPlanTool(originalPrompt, this.state);
    const mediaTools = [
      this.options.tools.generateVideo,
      this.options.tools.generateFoley,
      this.options.tools.generateMusic,
      this.options.tools.assembleVideo,
      ...(this.options.tools.additionalTools ?? []),
    ];
    const extraTools = [validatePlanTool, ...mediaTools, ...(uploadTool ? [uploadTool] : [])];
    assertUniqueToolNames(extraTools);

    const promptToolNames = {
      validatePlan: validatePlanTool.name,
      generateVideo: this.options.tools.generateVideo.name,
      generateMusic: this.options.tools.generateMusic.name,
      generateFoley: this.options.tools.generateFoley.name,
      assembleVideo: this.options.tools.assembleVideo.name,
      ...(uploadTool ? { youtubeUpload: uploadTool.name } : {}),
    };
    const systemPromptExtension = createVideoSystemPrompt({
      tools: promptToolNames,
      youtubeUploadRequested: uploadRequested,
      youtubeUploadAuthorized: Boolean(uploadTool),
      ...(this.options.additionalSystemRules ? { additionalRules: this.options.additionalSystemRules } : {}),
    });

    const frameworkDatabase = this.#frameworkDatabase
      ?? new LocalFrameworkDatabase(this.options.runDirectory, promptHash);
    const runner = new DeepAgentRunner(frameworkDatabase.asDatabaseClient(), {
      ...(this.options.frameworkOptions ?? {}),
      // The tool schema generic is invariant across this concrete union and the
      // framework option type; the runtime DynamicStructuredTool API is shared.
      extraTools: extraTools as unknown as NonNullable<DeepAgentRunnerOptions['extraTools']>,
      systemPromptExtension,
    });
    scopeFrameworkFilesystemToRunDirectory(runner, this.options.runDirectory);
    const result = await runner.run(originalPrompt);
    return {
      ...result,
      youtubeUploadRequested: uploadRequested,
      youtubeUploadAuthorized: Boolean(uploadTool),
    };
  }
}

export function createVideoAgentRunner(options: CreateVideoAgentRunnerOptions): VideoAgentRunner {
  return new DefaultVideoAgentRunner(options);
}

export async function createBootstrappedVideoAgentRunner(
  options: CreateVideoAgentRunnerOptions,
): Promise<VideoAgentRunner> {
  return createVideoAgentRunner(options);
}
