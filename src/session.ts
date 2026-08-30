// Who is calling, and what they're working on.
//
// HTTP requests are stateless — each one builds a fresh server — so the working
// scope can't live on a connection. It's keyed by the caller's credential
// instead, which is the closest thing to a stable identity we have and keeps
// two techs on different runs from stepping on each other.

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { config } from './config.js';

export interface Credential {
  apiKey?: string;
  jwt?: string;
}

export interface Scope {
  teamId?: string;
  projectId?: string;
  experimentId?: string;
}

const credentials = new AsyncLocalStorage<Credential>();

export function withCredential<T>(credential: Credential, run: () => Promise<T>): Promise<T> {
  return credentials.run(credential, run);
}

export function currentCredential(): Credential {
  return credentials.getStore() ?? { apiKey: config.apiKey, jwt: config.jwt };
}

const scopes = new Map<string, Scope>();
const MAX_SCOPES = 500;

function callerKey(): string {
  const credential = currentCredential();
  return createHash('sha256').update(credential.apiKey ?? credential.jwt ?? '').digest('hex');
}

export function getScope(): Scope {
  return scopes.get(callerKey()) ?? {};
}

// Replaces rather than merges: the ids are nested, so a new team invalidates
// the project under it. Callers build the whole scope explicitly.
export function saveScope(scope: Scope): Scope {
  const key = callerKey();
  scopes.delete(key);
  if (scopes.size >= MAX_SCOPES) scopes.delete(scopes.keys().next().value!);
  scopes.set(key, scope);
  return scope;
}

export class ScopeError extends Error {}

export function requireTeam(): string {
  const { teamId } = getScope();
  if (!teamId) throw new ScopeError('No team selected. Call list_teams, then set_scope.');
  return teamId;
}

export function requireExperiment(): Required<Scope> {
  const scope = getScope();
  if (!scope.teamId || !scope.projectId || !scope.experimentId) {
    throw new ScopeError(
      'No experiment selected. Call scinote_status to see the current scope, then list_teams / list_projects / list_experiments and set_scope.'
    );
  }
  return scope as Required<Scope>;
}
