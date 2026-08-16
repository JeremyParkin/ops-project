import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

let loaded = false;

function parseEnvLine(line: string) {
  const trimmed = line.trim();

  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const separatorIndex = trimmed.indexOf("=");

  if (separatorIndex === -1) {
    return null;
  }

  const key = trimmed.slice(0, separatorIndex).trim();
  let value = trimmed.slice(separatorIndex + 1).trim();

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return { key, value };
}

export function loadE2eEnv() {
  if (loaded) {
    return;
  }

  loaded = true;

  const envPath = path.resolve(process.cwd(), ".env.local");

  if (!existsSync(envPath)) {
    return;
  }

  const file = readFileSync(envPath, "utf8");

  file.split(/\r?\n/).forEach((line) => {
    const parsed = parseEnvLine(line);

    if (!parsed || process.env[parsed.key]) {
      return;
    }

    process.env[parsed.key] = parsed.value;
  });
}

export function requireE2eEnv() {
  loadE2eEnv();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseSecretKey) {
    throw new Error(
      "E2E tests require NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY.",
    );
  }

  return {
    supabaseUrl,
    supabaseSecretKey,
  };
}
