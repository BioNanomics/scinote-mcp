// Thin JSON:API client for the SciNote REST API.
//
// Route shapes (from scinote-web config/routes.rb, namespace :api/:v1):
//   /api/v1/teams/:team_id/projects/:project_id/experiments/:experiment_id/tasks
//   .../tasks/:task_id/protocols
//   .../tasks/:task_id/protocols/:protocol_id/steps            (PATCH :id -> completed)
//   .../steps/:step_id/checklists/:checklist_id/items          (PATCH :id -> checked)
//   .../tasks/:task_id/items                                   (task_inventory_items; PATCH :id -> consume_stock)
//   .../tasks/:task_id/results
//   /api/v1/teams/:team_id/inventories/:inventory_id/items
//   /api/status, /api/health
//
// Controller sources to consult when a payload is rejected:
//   scinote-web/app/controllers/api/v1/*.rb

import { config } from './config.js';

export interface JsonApiResource {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
  relationships?: Record<string, unknown>;
}

export class SciNoteError extends Error {
  constructor(public status: number, public body: string, url: string) {
    super(`SciNote API ${status} for ${url}: ${body.slice(0, 300)}`);
  }
}

async function request<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown
): Promise<T> {
  const url = `${config.baseUrl}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/vnd.api+json' };
  if (config.apiKey) headers['Api-Key'] = config.apiKey;
  else headers['Authorization'] = `Bearer ${config.jwt}`;

  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new SciNoteError(res.status, text, url);
  return (text ? JSON.parse(text) : {}) as T;
}

// Fetches every page of a JSON:API collection.
async function listAll(path: string): Promise<JsonApiResource[]> {
  const out: JsonApiResource[] = [];
  let next: string | null = `${path}${path.includes('?') ? '&' : '?'}page%5Bsize%5D=100`;
  while (next) {
    const page: { data: JsonApiResource[]; links?: { next?: string | null } } =
      await request('GET', next);
    out.push(...page.data);
    next = page.links?.next ? page.links.next.replace(config.baseUrl, '') : null;
  }
  return out;
}

const scope = () =>
  `/api/v1/teams/${config.teamId}/projects/${config.projectId}/experiments/${config.experimentId}`;

export const scinote = {
  status: () => request<{ message: string; versions: unknown[] }>('GET', '/api/status'),

  listTasks: () => listAll(`${scope()}/tasks`),

  listProtocols: (taskId: string) => listAll(`${scope()}/tasks/${taskId}/protocols`),

  listSteps: (taskId: string, protocolId: string) =>
    listAll(`${scope()}/tasks/${taskId}/protocols/${protocolId}/steps?include=checklists,checklists.checklist_items`),

  // --- Milestone 2 (verify payloads against app/controllers/api/v1/steps_controller.rb
  //     and checklist_items_controller.rb, then wire up in index.ts) ---

  updateStep: (taskId: string, protocolId: string, stepId: string, completed: boolean) =>
    request('PATCH', `${scope()}/tasks/${taskId}/protocols/${protocolId}/steps/${stepId}`, {
      data: { id: stepId, type: 'steps', attributes: { completed } }
    }),

  updateChecklistItem: (
    taskId: string, protocolId: string, stepId: string,
    checklistId: string, itemId: string, checked: boolean
  ) =>
    request(
      'PATCH',
      `${scope()}/tasks/${taskId}/protocols/${protocolId}/steps/${stepId}/checklists/${checklistId}/items/${itemId}`,
      { data: { id: itemId, type: 'checklist_items', attributes: { checked } } }
    ),

  // --- Milestone 3 (see app/controllers/api/v1/task_inventory_items_controller.rb) ---

  listTaskItems: (taskId: string) => listAll(`${scope()}/tasks/${taskId}/items`),

  assignItem: (taskId: string, inventoryItemId: string) =>
    request('POST', `${scope()}/tasks/${taskId}/items`, {
      data: { type: 'inventory_items', attributes: { item_id: Number(inventoryItemId) } }
    }),

  consumeStock: (taskId: string, itemId: string, amount: number, comment?: string) =>
    request('PATCH', `${scope()}/tasks/${taskId}/items/${itemId}`, {
      data: {
        id: itemId,
        type: 'inventory_items',
        attributes: { stock_consumption: amount, stock_consumption_comment: comment ?? '' }
      }
    }),

  listInventoryItems: (inventoryId: string) =>
    listAll(`/api/v1/teams/${config.teamId}/inventories/${inventoryId}/items?include=inventory_cells`)
};
