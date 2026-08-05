import http from 'node:http';

/**
 * No connection reuse between requests.
 *
 * The pair to the single long-lived server in `helpers/testApp.ts`, and the reason both
 * are needed. Since Node 19 the global agent keeps sockets pooled, so a response leaves
 * its connection open — and `server.close()` waits for open connections to end, which
 * turns closing a harness into a hang. Reuse buys nothing here: the client is a test
 * making one request at a time, not a browser.
 *
 * Replaced rather than reconfigured: `keepAlive` is a construction option, and the
 * agent's type does not expose it as a settable property. This module runs before any
 * request is made, so nothing has been pooled yet.
 */
http.globalAgent = new http.Agent({ keepAlive: false });

/**
 * Keeps application logging out of the test report.
 *
 * The code under test logs deliberately — a rejected login, a reused refresh token
 * — and several tests provoke exactly those paths. Printed for real, they bury the
 * one line that matters when something fails.
 *
 * Silenced by replacing the console methods rather than by giving the logger a
 * quiet mode: a switch would mean production runs code no test exercises. Tests
 * that assert on a log line simply spy on the same method, and `restoreMocks` puts
 * the originals back afterwards.
 */
function silenceConsole(): void {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
}

/* Once at load, which covers the `beforeAll` hooks that build a harness and sign
   people in, and again before each test, because `restoreMocks` puts the real
   console back between them. */
silenceConsole();
beforeEach(silenceConsole);
