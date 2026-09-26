import { readFileSync } from 'node:fs';

// Tests run against the local Docker stack (npm run stack), in their own databases and bucket.
const dev = Object.fromEntries(
  readFileSync(new URL('../../infra/dev.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

export const testEnv: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  ROLE: 'laptop',
  PRIMARY_URL: 'postgres://postgres:postgres@localhost:54322/breader_test',
  MIRROR_URL: 'postgres://breader:breader@localhost:54333/breader_test',
  KEY_PEPPER: dev.KEY_PEPPER,
  SESSION_SECRET: dev.SESSION_SECRET,
  COOKIE_SECURE: 'false',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'breader-test',
  S3_BACKUP_BUCKET: 'breader-test-backups',
  S3_ACCESS_KEY_ID: dev.S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: dev.S3_SECRET_ACCESS_KEY,
  S3_FORCE_PATH_STYLE: 'true',
};
