import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseClient } from "freetier-deepagent-framework";
import { readJsonIfPresent } from "../utils/files.js";

type RunStatus = "pending" | "in_progress" | "completed" | "failed";
type TodoStatus = "pending" | "in_progress" | "completed";

interface LocalAgentRun {
  prompt_hash: string;
  user_prompt: string;
  status: RunStatus;
  current_provider: string | null;
  thread_id: string;
  final_result: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface LocalAgentTodo {
  id: number;
  prompt_hash: string;
  todo_index: number;
  content: string;
  status: TodoStatus;
  result_note: string | null;
  updated_at: string;
}

interface LocalAgentEvent {
  id: number;
  event_type: string;
  details: Record<string, unknown>;
  created_at: string;
}

interface LocalGraphCheckpoint {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  checkpoint: unknown;
  metadata: unknown;
  created_at: string;
}

interface LocalGraphWrite {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  task_id: string;
  idx: number;
  channel: string;
  value: unknown;
}

export interface PlanningGraphRestartResult {
  restarted: boolean;
  clearedTodos: number;
  clearedCheckpoints: number;
  clearedWrites: number;
}

interface LocalFrameworkDocument {
  schemaVersion: 2;
  run: LocalAgentRun | null;
  todos: LocalAgentTodo[];
  events: LocalAgentEvent[];
  checkpoints: Record<string, LocalGraphCheckpoint>;
  writes: Record<string, LocalGraphWrite>;
}

function emptyDocument(): LocalFrameworkDocument {
  return {
    schemaVersion: 2,
    run: null,
    todos: [],
    events: [],
    checkpoints: {},
    writes: {},
  };
}

function hashPrompt(originalPrompt: string): string {
  const normalized = originalPrompt.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex");
}

function checkpointKey(threadId: string, namespace: string, checkpointId: string): string {
  return JSON.stringify([threadId, namespace, checkpointId]);
}

function writeKey(
  threadId: string,
  namespace: string,
  checkpointId: string,
  taskId: string,
  index: number,
): string {
  return JSON.stringify([threadId, namespace, checkpointId, taskId, index]);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.part-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function nextRevisionTimestamp(previous: string): string {
  const previousMilliseconds = Date.parse(previous);
  return new Date(Math.max(
    Date.now(),
    Number.isFinite(previousMilliseconds) ? previousMilliseconds + 1 : Date.now(),
  )).toISOString();
}

function validateDocument(value: unknown, filePath: string): LocalFrameworkDocument {
  if (!value || typeof value !== "object" || (value as { schemaVersion?: unknown }).schemaVersion !== 2) {
    throw new Error(`Invalid local framework state: ${filePath}`);
  }
  const candidate = value as Partial<LocalFrameworkDocument>;
  if (
    !Array.isArray(candidate.todos)
    || !Array.isArray(candidate.events)
    || !candidate.checkpoints
    || typeof candidate.checkpoints !== "object"
    || !candidate.writes
    || typeof candidate.writes !== "object"
  ) {
    throw new Error(`Incomplete local framework state: ${filePath}`);
  }
  return candidate as LocalFrameworkDocument;
}

/**
 * Filesystem implementation of the pinned framework's DatabaseClient surface.
 * The framework currently hard-wires its StateStore and NeonCheckpointSaver
 * around that concrete type; this adapter keeps their behavior without a DB.
 */
export class LocalFrameworkDatabase {
  readonly #runDirectory: string;
  readonly #filePath: string;
  readonly #promptHash: string;
  #mutex: Promise<void> = Promise.resolve();

  constructor(runDirectory: string, promptHash?: string) {
    this.#runDirectory = path.resolve(runDirectory);
    this.#promptHash = promptHash ?? path.basename(this.#runDirectory);
    if (!/^[a-f0-9]{64}$/.test(this.#promptHash)) {
      throw new Error(`Framework state requires a valid prompt hash: ${this.#runDirectory}`);
    }
    this.#filePath = path.join(this.#runDirectory, "agent-state.json");
  }

  /** The sole compatibility cast for the pinned database-shaped framework API. */
  asDatabaseClient(): DatabaseClient {
    return this as unknown as DatabaseClient;
  }

  async getRun(promptHash: string): Promise<LocalAgentRun | null> {
    this.#assertPromptHash(promptHash);
    return this.#exclusive(async () => structuredClone((await this.#read()).run));
  }

  async createRun(
    promptHash: string,
    userPrompt: string,
    threadId: string,
    provider: string,
  ): Promise<LocalAgentRun> {
    this.#assertPromptHash(promptHash);
    if (hashPrompt(userPrompt) !== promptHash) throw new Error("Agent prompt does not match its run hash.");
    return this.#mutate((document) => {
      if (document.run) return structuredClone(document.run);
      const now = new Date().toISOString();
      document.run = {
        prompt_hash: promptHash,
        user_prompt: userPrompt,
        status: "in_progress",
        current_provider: provider,
        thread_id: threadId,
        final_result: null,
        error_message: null,
        created_at: now,
        updated_at: now,
      };
      return structuredClone(document.run);
    });
  }

  async updateRunStatus(promptHash: string, status: RunStatus, errorMessage?: string): Promise<void> {
    this.#assertPromptHash(promptHash);
    await this.#mutate((document) => {
      const run = this.#requireRun(document);
      run.status = status;
      run.error_message = errorMessage ?? null;
      run.updated_at = new Date().toISOString();
    });
  }

  async setCurrentProvider(promptHash: string, provider: string): Promise<void> {
    this.#assertPromptHash(promptHash);
    await this.#mutate((document) => {
      const run = this.#requireRun(document);
      run.current_provider = provider;
      run.updated_at = new Date().toISOString();
    });
  }

  async setFinalResult(promptHash: string, result: string): Promise<void> {
    this.#assertPromptHash(promptHash);
    await this.#mutate((document) => {
      const run = this.#requireRun(document);
      run.final_result = result;
      run.error_message = null;
      run.status = "completed";
      run.updated_at = new Date().toISOString();
    });
  }

  async getTodos(promptHash: string): Promise<LocalAgentTodo[]> {
    this.#assertPromptHash(promptHash);
    return this.#exclusive(async () => structuredClone((await this.#read()).todos)
      .sort((left, right) => left.todo_index - right.todo_index));
  }

  async replaceTodos(
    promptHash: string,
    todos: Array<{ content: string; status: TodoStatus }>,
  ): Promise<void> {
    this.#assertPromptHash(promptHash);
    await this.#mutate((document) => {
      const now = new Date().toISOString();
      document.todos = todos.map((todo, index) => ({
        id: index + 1,
        prompt_hash: promptHash,
        todo_index: index,
        content: todo.content,
        status: todo.status,
        result_note: null,
        updated_at: now,
      }));
    });
  }

  async updateTodoStatus(
    promptHash: string,
    todoIndex: number,
    status: TodoStatus,
    resultNote?: string,
  ): Promise<void> {
    this.#assertPromptHash(promptHash);
    await this.#mutate((document) => {
      const todo = document.todos.find((candidate) => candidate.todo_index === todoIndex);
      if (!todo) return;
      todo.status = status;
      todo.result_note = resultNote ?? null;
      todo.updated_at = new Date().toISOString();
    });
  }

  async resetFailedRun(promptHash: string, provider: string): Promise<void> {
    this.#assertPromptHash(promptHash);
    await this.#mutate((document) => {
      const run = this.#requireRun(document);
      if (run.status !== "failed") return;
      run.status = "in_progress";
      run.current_provider = provider;
      run.error_message = null;
      run.final_result = null;
      run.updated_at = new Date().toISOString();
      document.todos = [];
    });
  }

  /**
   * Atomically discard an earlier pre-media LangGraph transcript before a new
   * application invocation replans the same prompt. This is deliberately
   * compare-and-set guarded: a caller that observed an older run revision may
   * not erase graph work written by a newer process. Video plans, provider
   * receipts, and media checkpoints are stored outside this document and are
   * never touched here; the caller must verify those are absent first.
   */
  async restartPreMediaPlanningState(
    promptHash: string,
    expected: Pick<LocalAgentRun, "status" | "thread_id" | "updated_at">,
    reason: string,
    initialProvider: string,
  ): Promise<PlanningGraphRestartResult> {
    this.#assertPromptHash(promptHash);
    return this.#mutate((document) => {
      const run = this.#requireRun(document);
      const unchanged = run.status === expected.status
        && run.thread_id === expected.thread_id
        && run.updated_at === expected.updated_at;
      if (!unchanged) {
        return {
          restarted: false,
          clearedTodos: 0,
          clearedCheckpoints: 0,
          clearedWrites: 0,
        };
      }

      const clearedTodos = document.todos.length;
      let clearedCheckpoints = 0;
      let clearedWrites = 0;
      document.todos = [];
      for (const [key, checkpoint] of Object.entries(document.checkpoints)) {
        if (checkpoint.thread_id !== run.thread_id) continue;
        delete document.checkpoints[key];
        clearedCheckpoints += 1;
      }
      for (const [key, write] of Object.entries(document.writes)) {
        if (write.thread_id !== run.thread_id) continue;
        delete document.writes[key];
        clearedWrites += 1;
      }

      const previousStatus = run.status;
      run.status = "in_progress";
      run.current_provider = initialProvider;
      run.final_result = null;
      run.error_message = null;
      const restartedAt = nextRevisionTimestamp(run.updated_at);
      run.updated_at = restartedAt;
      document.events.push({
        id: (document.events.at(-1)?.id ?? 0) + 1,
        event_type: "pre_media_planning_state_restarted",
        details: {
          reason,
          previousStatus,
          resetProvider: initialProvider,
          clearedTodos,
          clearedCheckpoints,
          clearedWrites,
        },
        created_at: restartedAt,
      });
      return {
        restarted: true,
        clearedTodos,
        clearedCheckpoints,
        clearedWrites,
      };
    });
  }

  /**
   * Reopen only the exact framework completion that the caller just rejected.
   * The compare-and-set guard prevents a stale process from overwriting a newer
   * successful agent result. Video/media state lives in separate durable files
   * and is deliberately untouched.
   */
  async reopenRejectedCompletion(
    promptHash: string,
    expectedFinalResult: string,
    reason: string,
  ): Promise<boolean> {
    this.#assertPromptHash(promptHash);
    return this.#mutate((document) => {
      const run = this.#requireRun(document);
      if (run.status !== "completed" || run.final_result !== expectedFinalResult) return false;

      run.status = "in_progress";
      run.final_result = null;
      run.error_message = reason;
      run.updated_at = new Date().toISOString();
      document.todos = [];
      for (const [key, checkpoint] of Object.entries(document.checkpoints)) {
        if (checkpoint.thread_id === run.thread_id) delete document.checkpoints[key];
      }
      for (const [key, write] of Object.entries(document.writes)) {
        if (write.thread_id === run.thread_id) delete document.writes[key];
      }
      document.events.push({
        id: (document.events.at(-1)?.id ?? 0) + 1,
        event_type: "agent_completion_rejected",
        details: { reason },
        created_at: new Date().toISOString(),
      });
      return true;
    });
  }

  /**
   * Reopen only the exact transient framework failure observed by the caller.
   * The framework currently classifies non-Requesty 5xx responses as retryable
   * but still marks the run failed before rethrowing them. Clear only its agent
   * graph state so a bounded host retry starts a clean planning turn; durable
   * video plans and media receipts live in separate files and are untouched.
   */
  async reopenRetryableFailure(
    promptHash: string,
    expectedErrorMessage: string,
    expectedFailureUpdatedAt: string,
    reason: string,
  ): Promise<boolean> {
    this.#assertPromptHash(promptHash);
    return this.#mutate((document) => {
      const run = this.#requireRun(document);
      if (
        run.status !== "failed"
        || run.error_message !== expectedErrorMessage
        || run.updated_at !== expectedFailureUpdatedAt
      ) return false;

      run.status = "in_progress";
      run.final_result = null;
      run.error_message = reason;
      run.updated_at = new Date().toISOString();
      document.todos = [];
      for (const [key, checkpoint] of Object.entries(document.checkpoints)) {
        if (checkpoint.thread_id === run.thread_id) delete document.checkpoints[key];
      }
      for (const [key, write] of Object.entries(document.writes)) {
        if (write.thread_id === run.thread_id) delete document.writes[key];
      }
      document.events.push({
        id: (document.events.at(-1)?.id ?? 0) + 1,
        event_type: "retryable_agent_failure_reopened",
        details: { reason },
        created_at: new Date().toISOString(),
      });
      return true;
    });
  }

  /** Commit a recovered invocation only while the exact observed failure is current. */
  async completeRetryableFailureFromDurableState(
    promptHash: string,
    expectedErrorMessage: string,
    expectedFailureUpdatedAt: string,
    finalResult: string,
  ): Promise<boolean> {
    this.#assertPromptHash(promptHash);
    return this.#mutate((document) => {
      const run = this.#requireRun(document);
      if (
        run.status !== "failed"
        || run.error_message !== expectedErrorMessage
        || run.updated_at !== expectedFailureUpdatedAt
      ) return false;

      run.status = "completed";
      run.final_result = finalResult;
      run.error_message = null;
      run.updated_at = new Date().toISOString();
      document.todos = [];
      for (const [key, checkpoint] of Object.entries(document.checkpoints)) {
        if (checkpoint.thread_id === run.thread_id) delete document.checkpoints[key];
      }
      for (const [key, write] of Object.entries(document.writes)) {
        if (write.thread_id === run.thread_id) delete document.writes[key];
      }
      document.events.push({
        id: (document.events.at(-1)?.id ?? 0) + 1,
        event_type: "retryable_agent_failure_recovered",
        details: { recovery: "durable_video_state" },
        created_at: new Date().toISOString(),
      });
      return true;
    });
  }

  async logEvent(
    promptHash: string,
    eventType: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    this.#assertPromptHash(promptHash);
    await this.#mutate((document) => {
      document.events.push({
        id: (document.events.at(-1)?.id ?? 0) + 1,
        event_type: eventType,
        details,
        created_at: new Date().toISOString(),
      });
    });
  }

  async getCheckpoint(threadId: string, checkpointId: string): Promise<LocalGraphCheckpoint | null> {
    return this.#exclusive(async () => {
      const checkpoint = Object.values((await this.#read()).checkpoints)
        .find((candidate) => candidate.thread_id === threadId && candidate.checkpoint_id === checkpointId);
      return checkpoint ? structuredClone(checkpoint) : null;
    });
  }

  async getLatestCheckpoint(threadId: string): Promise<LocalGraphCheckpoint | null> {
    return this.#exclusive(async () => {
      const checkpoint = Object.values((await this.#read()).checkpoints)
        .filter((candidate) => candidate.thread_id === threadId)
        .sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
      return checkpoint ? structuredClone(checkpoint) : null;
    });
  }

  async saveCheckpoint(
    threadId: string,
    checkpointId: string,
    checkpoint: unknown,
    metadata: unknown,
    parentCheckpointId?: string,
  ): Promise<void> {
    await this.#mutate((document) => {
      const key = checkpointKey(threadId, "", checkpointId);
      document.checkpoints[key] = {
        thread_id: threadId,
        checkpoint_ns: "",
        checkpoint_id: checkpointId,
        parent_checkpoint_id: parentCheckpointId ?? null,
        checkpoint,
        metadata,
        created_at: document.checkpoints[key]?.created_at ?? new Date().toISOString(),
      };
    });
  }

  async listCheckpoints(threadId: string, limit = 100): Promise<LocalGraphCheckpoint[]> {
    return this.#exclusive(async () => structuredClone(Object.values((await this.#read()).checkpoints)
      .filter((candidate) => candidate.thread_id === threadId)
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .slice(0, limit)));
  }

  async saveCheckpointWrite(
    threadId: string,
    checkpointNamespace: string,
    checkpointId: string,
    taskId: string,
    index: number,
    channel: string,
    value: unknown,
  ): Promise<void> {
    await this.#mutate((document) => {
      document.writes[writeKey(threadId, checkpointNamespace, checkpointId, taskId, index)] = {
        thread_id: threadId,
        checkpoint_ns: checkpointNamespace,
        checkpoint_id: checkpointId,
        task_id: taskId,
        idx: index,
        channel,
        value,
      };
    });
  }

  async deleteThreadCheckpoints(threadId: string): Promise<void> {
    await this.#mutate((document) => {
      for (const [key, checkpoint] of Object.entries(document.checkpoints)) {
        if (checkpoint.thread_id === threadId) delete document.checkpoints[key];
      }
      for (const [key, write] of Object.entries(document.writes)) {
        if (write.thread_id === threadId) delete document.writes[key];
      }
    });
  }

  async compactCompletedRun(promptHash: string): Promise<void> {
    this.#assertPromptHash(promptHash);
    await this.#mutate((document) => {
      document.todos = [];
      document.events = [];
    });
  }

  #assertPromptHash(promptHash: string): void {
    if (promptHash !== this.#promptHash) {
      throw new Error(`Framework state requested for a different run: ${promptHash}`);
    }
  }

  #requireRun(document: LocalFrameworkDocument): LocalAgentRun {
    if (!document.run) throw new Error("Local framework run has not been created.");
    return document.run;
  }

  async #read(): Promise<LocalFrameworkDocument> {
    const value = await readJsonIfPresent<unknown>(this.#filePath);
    return value === null ? emptyDocument() : validateDocument(value, this.#filePath);
  }

  async #mutate<T>(operation: (document: LocalFrameworkDocument) => T): Promise<T> {
    return this.#exclusive(async () => {
      const document = await this.#read();
      const result = operation(document);
      await writeJsonAtomic(this.#filePath, document);
      return result;
    });
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const predecessor = this.#mutex;
    this.#mutex = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
