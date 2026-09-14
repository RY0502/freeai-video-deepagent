import assert from 'node:assert/strict';
import test from 'node:test';

import { pauseVmBeforeExit } from '../src/pause.js';

test('pauseVmBeforeExit calls the configured VM pause endpoint', async () => {
  let requestedUrl: string | undefined;
  await pauseVmBeforeExit(
    { PAUSE_BASE_URL: 'https://pause.example.test/' },
    async (input) => {
      requestedUrl = String(input);
      return new Response(null, { status: 204 });
    },
  );

  assert.equal(requestedUrl, 'https://pause.example.test/pause/vm');
});

test('pauseVmBeforeExit does not throw when the pause request fails', async () => {
  await assert.doesNotReject(() => pauseVmBeforeExit(
    { PAUSE_BASE_URL: 'https://pause.example.test' },
    async () => { throw new Error('service unavailable'); },
  ));
});

test('pauseVmBeforeExit retries transient service failures', async () => {
  const responses = [
    new Response(null, { status: 503 }),
    new Response(null, { status: 204 }),
  ];
  const requestedUrls: string[] = [];

  await pauseVmBeforeExit(
    { PAUSE_BASE_URL: 'https://pause.example.test' },
    async (input) => {
      requestedUrls.push(String(input));
      return responses.shift() as Response;
    },
  );

  assert.deepEqual(requestedUrls, [
    'https://pause.example.test/pause/vm',
    'https://pause.example.test/pause/vm',
  ]);
});