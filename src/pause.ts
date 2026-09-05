export interface PauseEnvironment {
  PAUSE_BASE_URL?: string;
}

const PAUSE_REQUEST_ATTEMPTS = 3;
const PAUSE_REQUEST_TIMEOUT_MS = 10_000;

export async function pauseVmBeforeExit(
  env: PauseEnvironment | NodeJS.ProcessEnv = process.env,
  fetchImplementation: typeof fetch = fetch,
): Promise<void> {
  const baseUrl = env.PAUSE_BASE_URL?.replace(/\/$/, '');
  if (!baseUrl) {
    console.error('Unable to pause VM: PAUSE_BASE_URL must be set.');
    return;
  }

  const pauseUrl = `${baseUrl}/pause/vm`;
  console.log(`Pausing VM via ${pauseUrl}`);

  for (let attempt = 1; attempt <= PAUSE_REQUEST_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PAUSE_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImplementation(pauseUrl, {
        method: "GET",
        signal: controller.signal,
      });
      if (response.ok) {
        console.log(`VM pause request accepted with HTTP ${response.status}.`);
        return;
      }
      if (response.status < 500 || attempt === PAUSE_REQUEST_ATTEMPTS) {
        console.error(`Unable to pause VM: pause service returned HTTP ${response.status}.`);
        return;
      }
      console.error(`Pause service returned HTTP ${response.status}; retrying.`);
    } catch (error) {
      if (attempt === PAUSE_REQUEST_ATTEMPTS) {
        console.error(`Unable to pause VM: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      console.error(`Pause request failed; retrying: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}