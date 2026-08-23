import path from "node:path";

export const E2E_AUTH_STORAGE_STATE = path.resolve(
  process.cwd(),
  "tests/e2e/.auth/e2e-auth.json",
);
