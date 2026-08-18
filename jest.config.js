/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@app/(.*)$': '<rootDir>/src/$1',
  },
  testTimeout: 30000,
  // These are end-to-end suites: each boots the real app against the ONE local
  // Postgres and the ONE local Redis. Run in parallel they clobber each other's
  // state — throttle counters get cleared mid-assertion, queue rows move under
  // a concurrency test — and ~30 tests fail non-deterministically while the same
  // suites pass in isolation. Serial execution is the correctness requirement
  // here, not a speed trade-off: the whole suite still finishes in under a
  // minute because the cost was always the shared fixtures, not the workers.
  maxWorkers: 1,
};
