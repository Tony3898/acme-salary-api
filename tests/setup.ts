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
