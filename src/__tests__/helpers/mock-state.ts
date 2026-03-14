/**
 * Shared mutable state for mocking next/headers cookies across tests.
 * Import this in any test file that mocks next/headers, then set
 * mockState.sessionCookie in beforeEach to control which session is active.
 */
export const mockState = {
  sessionCookie: undefined as string | undefined,
};
