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
  teamId: process.env.SCINOTE_TEAM_ID || '',
  projectId: process.env.SCINOTE_PROJECT_ID || '',
  experimentId: process.env.SCINOTE_EXPERIMENT_ID || ''
};

if (!config.apiKey && !config.jwt) {
  throw new Error('Set SCINOTE_API_KEY or SCINOTE_JWT in .env');
}
