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
  relationships?: Record<string, Relationship>;
}

export interface Relationship {
  data: ResourceRef | ResourceRef[] | null;
}

export interface ResourceRef {
  id: string;
  type: string;
}

export interface Collection {
  data: JsonApiResource[];
  included: JsonApiResource[];
}

export interface Single {
  data: JsonApiResource;
  included?: JsonApiResource[];
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

// Fetches every page of a JSON:API collection, accumulating `included` sideloads.
async function listAll(path: string): Promise<Collection> {
  const out: Collection = { data: [], included: [] };
  let next: string | null = `${path}${path.includes('?') ? '&' : '?'}page%5Bsize%5D=100`;
  while (next) {
    const page: {
      data: JsonApiResource[];
      included?: JsonApiResource[];
      links?: { next?: string | null };
    } = await request('GET', next);
    out.data.push(...page.data);
    if (page.included) out.included.push(...page.included);
    next = page.links?.next ? page.links.next.replace(config.baseUrl, '') : null;
  }
  return out;
}

// Indexes `included` resources for relationship lookup, keyed "type:id".
export function indexIncluded(included: JsonApiResource[] = []): Map<string, JsonApiResource> {
  return new Map(included.map((r) => [`${r.type}:${r.id}`, r]));
}

export function relatedRefs(resource: JsonApiResource, name: string): ResourceRef[] {
  const data = resource.relationships?.[name]?.data;
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

// SciNote embeds smart annotations like "[#Reagent name~rep_item~C4]" in free text.
// Techs hear this read aloud, so drop the markup and keep the label only when the
// surrounding prose doesn't already name it.
const ANNOTATION = /\[#([^~\]]+)~\w+~\w+\]/g;

export function plainText(value: unknown): string {
  const raw = String(value ?? '');
  const bare = raw.replace(ANNOTATION, ' ');
  return raw
    .replace(ANNOTATION, (_match, label: string) =>
      bare.toLowerCase().includes(label.toLowerCase()) ? ' ' : ` ${label}`
    )
    .replace(/\s+/g, ' ')
    .trim();
}

const scope = () =>
  `/api/v1/teams/${config.teamId}/projects/${config.projectId}/experiments/${config.experimentId}`;

export const scinote = {
  status: () => request<{ message: string; versions: unknown[] }>('GET', '/api/status'),

  listTasks: () => listAll(`${scope()}/tasks`),

  listProtocols: (taskId: string) => listAll(`${scope()}/tasks/${taskId}/protocols`),

  listSteps: (taskId: string, protocolId: string) =>
    listAll(`${scope()}/tasks/${taskId}/protocols/${protocolId}/steps?include=checklists,checklists.checklist_items`),

  getStep: (taskId: string, protocolId: string, stepId: string) =>
    request<Single>(
      'GET',
      `${scope()}/tasks/${taskId}/protocols/${protocolId}/steps/${stepId}?include=checklists,checklists.checklist_items`
    ),

  // --- Milestone 2 ---

  updateStep: (taskId: string, protocolId: string, stepId: string, completed: boolean) =>
    request<Single>('PATCH', `${scope()}/tasks/${taskId}/protocols/${protocolId}/steps/${stepId}`, {
      data: { id: stepId, type: 'steps', attributes: { completed } }
    }),

  updateChecklistItem: (
    taskId: string, protocolId: string, stepId: string,
    checklistId: string, itemId: string, checked: boolean
  ) =>
    request<Single>(
      'PATCH',
      `${scope()}/tasks/${taskId}/protocols/${protocolId}/steps/${stepId}/checklists/${checklistId}/items/${itemId}`,
      { data: { id: itemId, type: 'checklist_items', attributes: { checked } } }
    ),

  // --- Milestone 3 (see app/controllers/api/v1/task_inventory_items_controller.rb) ---

  listTaskItems: (taskId: string) => listAll(`${scope()}/tasks/${taskId}/items?include=inventory_cells`),

  getTaskItem: (taskId: string, itemId: string) =>
    request<Single>('GET', `${scope()}/tasks/${taskId}/items/${itemId}?include=inventory_cells`),

  assignItem: (taskId: string, inventoryItemId: string) =>
    request<Single>('POST', `${scope()}/tasks/${taskId}/items?include=inventory_cells`, {
      data: { type: 'inventory_items', attributes: { item_id: Number(inventoryItemId) } }
    }),

  // `stock_consumption` is the running total for this task, not a delta; the
  // ledger derives the delta itself. Callers must send the new cumulative total.
  setStockConsumption: (taskId: string, itemId: string, total: number, comment?: string) =>
    request<Single>('PATCH', `${scope()}/tasks/${taskId}/items/${itemId}`, {
      data: {
        id: itemId,
        type: 'inventory_items',
        attributes: { stock_consumption: total, stock_consumption_comment: comment ?? '' }
      }
    }),

  listInventoryItems: (inventoryId: string) =>
    listAll(`/api/v1/teams/${config.teamId}/inventories/${inventoryId}/items?include=inventory_cells`),

  listInventoryColumns: (inventoryId: string) =>
    listAll(`/api/v1/teams/${config.teamId}/inventories/${inventoryId}/columns`),

  // --- Milestone 4 (see app/controllers/api/v1/results_controller.rb) ---

  // Result text is sideposted as an `included` result_texts resource.
  createTextResult: (taskId: string, name: string, body: string) =>
    request<Single>('POST', `${scope()}/tasks/${taskId}/results`, {
      data: { type: 'results', attributes: { name } },
      included: [{ type: 'result_texts', attributes: { text: `<p>${escapeHtml(body)}</p>` } }]
    })
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Stock cells reference their unit by id, so resolve the inventory's unit list once.
const unitCache = new Map<string, Promise<Map<string, string>>>();

export function stockUnitNames(inventoryId: string): Promise<Map<string, string>> {
  let cached = unitCache.get(inventoryId);
  if (!cached) {
    cached = (async () => {
      const columns = await scinote.listInventoryColumns(inventoryId);
      const stockColumn = columns.data.find((c) => c.attributes.data_type === 'stock');
      if (!stockColumn) return new Map<string, string>();
      const units = await listAll(
        `/api/v1/teams/${config.teamId}/inventories/${inventoryId}/columns/${stockColumn.id}/stock_unit_items`
      );
      return new Map(units.data.map((u) => [u.id, String(u.attributes.data)]));
    })();
    unitCache.set(inventoryId, cached);
  }
  return cached;
}

export interface Stock {
  amount: number;
  unitId: string;
  lowStockThreshold: number | null;
}

export function stockOf(item: JsonApiResource, byRef: Map<string, JsonApiResource>): Stock | null {
  for (const ref of relatedRefs(item, 'inventory_cells')) {
    const cell = byRef.get(`${ref.type}:${ref.id}`);
    if (cell?.attributes.value_type !== 'stock') continue;
    const value = cell.attributes.value as {
      amount: string;
      low_stock_threshold: string | null;
      inventory_stock_unit_item_id: number;
    };
    return {
      amount: Number(value.amount),
      unitId: String(value.inventory_stock_unit_item_id),
      lowStockThreshold: value.low_stock_threshold === null ? null : Number(value.low_stock_threshold)
    };
  }
  return null;
}

export function inventoryIdOf(item: JsonApiResource): string | null {
  return relatedRefs(item, 'inventory')[0]?.id ?? null;
}
