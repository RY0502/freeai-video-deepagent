import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { VideoRunStateStore } from '../state/videoRunState.js';
import {
  VideoPlanPromptMismatchError,
  VideoPlanSchema,
  validateNewVideoPlanAudioChoreography,
} from './videoPlan.js';

const ValidateVideoPlanInputSchema = z.object({
  plan: VideoPlanSchema,
}).strict();

export interface RecoverableVideoPlanRejection {
  status: 'rejected';
  valid: false;
  recoverable: true;
  code: 'VIDEO_PLAN_PROMPT_MISMATCH';
  message: string;
  instruction: string;
}

/**
 * Prompt-derived plan mismatches are planner mistakes, not infrastructure
 * failures. Returning structured feedback keeps the tool call recoverable so
 * the agent can revise the plan without restarting the whole run.
 */
export function recoverableVideoPlanRejection(
  error: unknown,
  validateToolName = 'validate_video_plan',
): RecoverableVideoPlanRejection | null {
  if (!(error instanceof VideoPlanPromptMismatchError)) return null;
  return {
    status: 'rejected',
    valid: false,
    recoverable: true,
    code: 'VIDEO_PLAN_PROMPT_MISMATCH',
    message: error.message,
    instruction:
      `Revise the plan to match the original prompt, then call ${validateToolName} again. `
      + 'Do not call any generation tool until plan validation returns status stored or reused.',
  };
}

export function createValidateVideoPlanTool(
  originalPrompt: string,
  stateStore: VideoRunStateStore,
) {
  return new DynamicStructuredTool({
    name: 'validate_video_plan',
    description:
      'Validate and durably save the complete single-render VideoPlan before generating media; its default target is 10-12 seconds, with 4-9 seconds reserved for an explicit shorter user request. ' +
      'This must be called after write_todos and before video, music, or Foley generation. ' +
      'Plans use one creative script, gap-free global timeline beats, a continuity/negative bible, ' +
      'canonical camera motion, sample-addressable global Foley timing, ' +
      'prompt-controlled background music, and prompt-derived YouTube intent. ' +
      'A rejected response is recoverable: revise the plan using its message and call this tool again.',
    schema: ValidateVideoPlanInputSchema,
    func: async ({ plan }) => {
      // A locked plan is immutable. Load it outside the recoverable-candidate
      // catch so a corrupt/mismatched local plan remains a hard state error.
      const existing = await stateStore.loadPlan(originalPrompt);
      if (existing) {
        return JSON.stringify({
          status: 'reused',
          valid: true,
          changedPlanRejected: JSON.stringify(existing) !== JSON.stringify(plan),
          promptHash: stateStore.promptHash(originalPrompt),
          continuityBibleId: existing.continuityBible.id,
          timelineBeatCount: existing.timelineBeats.length,
          totalDurationSeconds: existing.totalDurationSeconds,
          youtubeUploadRequested: existing.youtubeUpload?.requested === true,
          instruction: 'A plan is already locked; continue with the stored plan.',
        });
      }
      let saved;
      try {
        validateNewVideoPlanAudioChoreography(plan);
        saved = await stateStore.savePlan(originalPrompt, plan);
      } catch (error) {
        const rejection = recoverableVideoPlanRejection(error);
        if (rejection) return JSON.stringify(rejection);
        throw error;
      }
      return JSON.stringify({
        status: 'stored',
        valid: true,
        promptHash: stateStore.promptHash(originalPrompt),
        continuityBibleId: saved.continuityBible.id,
        timelineBeatCount: saved.timelineBeats.length,
        totalDurationSeconds: saved.totalDurationSeconds,
        youtubeUploadRequested: saved.youtubeUpload?.requested === true,
      });
    },
  });
}
