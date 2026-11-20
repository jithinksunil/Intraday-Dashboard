import { existsSync } from 'node:fs';

export function loadEnv(path = '.env') {
  if (existsSync(path)) process.loadEnvFile(path);
}

export function requireEnv(...names) {
  const missing = names.filter((n) => !process.env[n]?.trim());
  if (missing.length) {
    throw new Error(
      `Missing ${missing.join(', ')}. Copy .env.example to .env and fill it in.`,
    );
  }
  return Object.fromEntries(names.map((n) => [n, process.env[n].trim()]));
}
