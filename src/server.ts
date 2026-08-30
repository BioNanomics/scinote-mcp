// SciNote MCP tool definitions.
//
// Tools (see README.md for the milestone history):
//   scinote_status, list_tasks, get_task_steps
//   tick_checklist_item, complete_step
//   list_task_items, assign_item, consume_stock
//   find_inventory_item, add_result_note
//
// Every write goes through the SciNote REST API with the tech's own credential
// so the audit trail, stock ledger, and permission checks stay intact.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  scinote,
  indexIncluded,
  relatedRefs,
  plainText,
  stockOf,
  stockUnitNames,
  inventoryIdOf,
  SciNoteError,
  type JsonApiResource
} from './scinote.js';

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
});

// Turns API failures into something a tech can act on rather than a stack trace.
// Ids go stale whenever a protocol is re-loaded, which is the common case here.
async function friendly(run: () => Promise<string>) {
  try {
    return text(await run());
  } catch (error) {
    if (!(error instanceof SciNoteError)) throw error;
    const advice =
      error.status === 403 ? "You don't have permission to do that in SciNote."
      : error.status === 404 ? "SciNote couldn't find that — the id may be stale. Re-run get_task_steps and try again."
      : `SciNote rejected the change: ${detailOf(error)}`;
    return { ...text(advice), isError: true };
  }
}

// Validation failures arrive as a JSON:API errors array; surface the detail so
// cases like re-assigning an item read as "already taken", not "status 400".
function detailOf(error: SciNoteError): string {
  try {
    const parsed = JSON.parse(error.body) as { errors?: Array<{ detail?: string }> };
    const detail = parsed.errors?.[0]?.detail;
    if (detail) return detail;
  } catch {
    // Non-JSON body (HTML error page, proxy timeout) — fall through.
  }
  return `SciNote returned ${error.status}.`;
}

// Renders "A1 - Aliquot 1 — 30 mL left (20 mL used on this task)" for a tech.
// The inventory relationship is only serialized on task-scoped endpoints, so
// callers that already know the inventory pass it in for the unit lookup.
async function describeItem(
  item: JsonApiResource,
  byRef: Map<string, JsonApiResource>,
  fallbackInventoryId?: string
) {
  const stock = stockOf(item, byRef);
  const inventoryId = inventoryIdOf(item) ?? fallbackInventoryId;
  const unit = stock && inventoryId ? (await stockUnitNames(inventoryId)).get(stock.unitId) ?? '' : '';
  const used = item.attributes.stock_consumption;

  const parts = [`${item.attributes.name}`];
  if (stock) {
    parts.push(`${stock.amount} ${unit} left`.trim());
    if (stock.lowStockThreshold !== null && stock.amount <= stock.lowStockThreshold) parts.push('LOW STOCK');
  }
  if (used) parts.push(`${Number(used)} ${unit} used on this task`.trim());
  return parts.join(' — ');
}

// Speech-to-text spells numbers out and drops punctuation, so "a1 aliquot two"
// has to reach the row named "A1 - Aliquot 2".
const NUMBER_WORDS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15',
  sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20'
};

function normalize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((token) => NUMBER_WORDS[token] ?? token);
}

// A server instance binds to exactly one transport, so HTTP sessions each get
// their own via this factory.
export function createServer(): McpServer {
  const server = new McpServer({ name: 'scinote-mcp', version: '0.1.0' });

  // -------------------------------------------------------------------------
  // Milestone 1 — read-only
  // -------------------------------------------------------------------------

  server.tool('scinote_status', 'Check SciNote API availability and supported versions', {}, async () => {
    return text(await scinote.status());
  });

  server.tool(
    'list_tasks',
    'List tasks (runs) in the configured experiment, with archived state',
    {},
    async () => {
      const tasks = await scinote.listTasks();
      return text(
        tasks.data.map((t) => ({ id: t.id, name: t.attributes.name, state: t.attributes.state }))
      );
    }
  );

  server.tool(
    'get_task_steps',
    'Get protocol steps for a task, including checklists and per-item checked state. Use this to find checklist item ids before ticking.',
    { taskId: z.string().describe('Task id from list_tasks') },
    async ({ taskId }) => {
      const protocols = await scinote.listProtocols(taskId);
      if (protocols.data.length === 0) return text('Task has no protocol');
      const protocolId = protocols.data[0].id;
      const steps = await scinote.listSteps(taskId, protocolId);
      const byRef = indexIncluded(steps.included);

      return text({
        protocolId,
        steps: steps.data.map((s) => ({
          id: s.id,
          name: plainText(s.attributes.name),
          position: s.attributes.position,
          completed: s.attributes.completed,
          checklists: relatedRefs(s, 'checklists').map((ref) => {
            const checklist = byRef.get(`${ref.type}:${ref.id}`);
            if (!checklist) return { id: ref.id, name: null, items: [] };
            return {
              id: checklist.id,
              name: plainText(checklist.attributes.name),
              items: relatedRefs(checklist, 'checklist_items').map((itemRef) => {
                const item = byRef.get(`${itemRef.type}:${itemRef.id}`);
                return {
                  id: itemRef.id,
                  text: plainText(item?.attributes.text),
                  checked: item?.attributes.checked ?? null
                };
              })
            };
          })
        }))
      });
    }
  );

  // -------------------------------------------------------------------------
  // Milestone 2 — protocol execution writes
  // -------------------------------------------------------------------------

  server.tool(
    'tick_checklist_item',
    'Mark a protocol checklist action item as done (checked)',
    {
      taskId: z.string(),
      protocolId: z.string(),
      stepId: z.string(),
      checklistId: z.string(),
      itemId: z.string(),
      checked: z.boolean().default(true)
    },
    async ({ taskId, protocolId, stepId, checklistId, itemId, checked }) =>
      friendly(async () => {
        const updated = await scinote.updateChecklistItem(
          taskId, protocolId, stepId, checklistId, itemId, checked
        );
        const label = plainText(updated.data.attributes.text);
        const step = await scinote.getStep(taskId, protocolId, stepId);
        const byRef = indexIncluded(step.included);
        const items = relatedRefs(byRef.get(`checklists:${checklistId}`)!, 'checklist_items')
          .map((ref) => byRef.get(`${ref.type}:${ref.id}`));
        const done = items.filter((i) => i?.attributes.checked).length;

        return `${checked ? 'Ticked' : 'Unticked'} "${label}" — ${done} of ${items.length} done on ${plainText(step.data.attributes.name)}`;
      })
  );

  server.tool(
    'complete_step',
    'Mark a protocol step (bench checkpoint) as completed — timestamps the checkpoint',
    { taskId: z.string(), protocolId: z.string(), stepId: z.string(), completed: z.boolean().default(true) },
    async ({ taskId, protocolId, stepId, completed }) =>
      friendly(async () => {
        const updated = await scinote.updateStep(taskId, protocolId, stepId, completed);
        const name = plainText(updated.data.attributes.name);
        const steps = await scinote.listSteps(taskId, protocolId);
        const done = steps.data.filter((s) => s.attributes.completed).length;

        return `${completed ? 'Completed' : 'Reopened'} ${name} — ${done} of ${steps.data.length} checkpoints done`;
      })
  );

  // -------------------------------------------------------------------------
  // Milestone 3 — inventory assignment + stock consumption
  // -------------------------------------------------------------------------

  server.tool(
    'list_task_items',
    'List inventory items assigned to a task, with current stock',
    { taskId: z.string() },
    async ({ taskId }) =>
      friendly(async () => {
        const items = await scinote.listTaskItems(taskId);
        const byRef = indexIncluded(items.included);
        const lines = await Promise.all(
          items.data.map(async (i) => `${i.id}: ${await describeItem(i, byRef)}`)
        );
        return lines.length ? lines.join('\n') : 'No inventory items assigned to this task yet.';
      })
  );

  server.tool(
    'assign_item',
    'Assign an inventory item (e.g. an arm aliquot) to a task',
    { taskId: z.string(), inventoryItemId: z.string().describe('Inventory row id, from find_inventory_item') },
    async ({ taskId, inventoryItemId }) =>
      friendly(async () => {
        const assigned = await scinote.assignItem(taskId, inventoryItemId);
        return `Assigned ${await describeItem(assigned.data, indexIncluded(assigned.included))} to the task.`;
      })
  );

  server.tool(
    'consume_stock',
    'Log stock consumed right now for an item assigned to a task (e.g. 20 mL). Writes the inventory ledger. ALWAYS confirm the amount and item name with the user before calling.',
    {
      taskId: z.string(),
      itemId: z.string().describe('Inventory row id, as shown by list_task_items'),
      amount: z.number().positive().describe('Amount consumed in this action, not the running total'),
      comment: z.string().optional().describe('Why it was used — shows on the ledger entry')
    },
    async ({ taskId, itemId, amount, comment }) =>
      friendly(async () => {
        const before = await scinote.getTaskItem(taskId, itemId);
        const alreadyUsed = Number(before.data.attributes.stock_consumption ?? 0);
        const after = await scinote.setStockConsumption(taskId, itemId, alreadyUsed + amount, comment);
        const byRef = indexIncluded(after.included);
        const unitId = stockOf(after.data, byRef)?.unitId;
        const inventoryId = inventoryIdOf(after.data);
        const unit = unitId && inventoryId ? (await stockUnitNames(inventoryId)).get(unitId) ?? '' : '';

        return `Logged ${amount} ${unit} — ${await describeItem(after.data, byRef)}`.replace(/\s+/g, ' ');
      })
  );

  // -------------------------------------------------------------------------
  // Milestone 4 — search + results
  // -------------------------------------------------------------------------

  server.tool(
    'find_inventory_item',
    'Find inventory items by name (e.g. "A1 aliquot two") and report stock levels. Returns the row ids that assign_item and consume_stock need.',
    {
      inventoryId: z.string().describe('Inventory id, e.g. "2" for GingiGuard Assay Reagents'),
      query: z.string().describe('Spoken or typed name fragment')
    },
    async ({ inventoryId, query }) =>
      friendly(async () => {
        const tokens = normalize(query);
        if (tokens.length === 0) return 'Nothing to search for.';

        const items = await scinote.listInventoryItems(inventoryId);
        const byRef = indexIncluded(items.included);
        const matches = items.data
          .map((item) => {
            const name = normalize(String(item.attributes.name));
            const squashed = name.join('');
            const hits = tokens.filter(
              (t) => name.some((n) => n.startsWith(t)) || squashed.includes(t)
            ).length;
            return { item, hits, length: squashed.length };
          })
          .filter((m) => m.hits === tokens.length)
          .sort((a, b) => a.length - b.length)
          .slice(0, 10);

        if (matches.length === 0) return `No inventory item matches "${query}".`;

        const lines = await Promise.all(
          matches.map(async (m) => `${m.item.id}: ${await describeItem(m.item, byRef, inventoryId)}`)
        );
        return lines.join('\n');
      })
  );

  server.tool(
    'add_result_note',
    'Add a text result to a task (e.g. Z-stack folder path, observations, deviations)',
    {
      taskId: z.string(),
      name: z.string().describe('Short title, e.g. "Z-stack location" or "Deviation"'),
      body: z.string().describe('The note itself, as dictated')
    },
    async ({ taskId, name, body }) =>
      friendly(async () => {
        const result = await scinote.createTextResult(taskId, name, body);
        return `Saved result "${result.data.attributes.name}" on the task.`;
      })
  );

  return server;
}
