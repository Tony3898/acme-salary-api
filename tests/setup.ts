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
beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
