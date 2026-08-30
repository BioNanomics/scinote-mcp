import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} (copy .env.example to .env)`);
  return v;
}

export const config = {
  baseUrl: required('SCINOTE_BASE_URL').replace(/\/$/, ''),
  apiKey: process.env.SCINOTE_API_KEY || '',
  jwt: process.env.SCINOTE_JWT || '',

  http: {
    port: Number(process.env.SCINOTE_MCP_PORT || 3001),
    // Loopback by default; set 0.0.0.0 when the reverse proxy runs on another
    // host. Requests are authenticated individually either way.
    bind: process.env.SCINOTE_MCP_BIND || '127.0.0.1',
    allowedHosts: list(process.env.SCINOTE_MCP_ALLOWED_HOSTS),
    allowedOrigins: list(process.env.SCINOTE_MCP_ALLOWED_ORIGINS),
    // Escape hatch for local testing: serve callers that send no credential
    // using the .env one. Never enable it on a publicly reachable deployment.
    allowSharedCredential: process.env.SCINOTE_MCP_ALLOW_SHARED_CREDENTIAL === 'true'
  }
};

function list(value: string | undefined): string[] {
  return (value || '').split(',').map((v) => v.trim()).filter(Boolean);
}

// Stdio has no per-request credential, so it needs one in .env.
export function requireLocalCredential(): void {
  if (!config.apiKey && !config.jwt) {
    throw new Error('Set SCINOTE_API_KEY or SCINOTE_JWT in .env');
  }
}
