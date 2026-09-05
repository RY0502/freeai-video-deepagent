export interface PauseEnvironment {
  PAUSE_BASE_URL?: string;
}

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
  try {
    const response = await fetchImplementation(pauseUrl);
    if (!response.ok) {
      console.error(`Unable to pause VM: pause service returned HTTP ${response.status}.`);
    }
  } catch (error) {
    console.error(`Unable to pause VM: ${error instanceof Error ? error.message : String(error)}`);
  }
}