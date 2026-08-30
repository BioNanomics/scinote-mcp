#!/usr/bin/env node
// SciNote MCP server — exposes bench workflows as MCP tools over stdio.
//
// Milestone map (see README.md):
//   M1  scinote_status, list_tasks, get_task_steps          [implemented]
//   M2  tick_checklist_item, complete_step                  [stubbed — your turn]
//   M3  list_task_items, assign_item, consume_stock         [stubbed]
//   M4  find_inventory_item, add_result_note                [stubbed]

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { scinote } from './scinote.js';

const server = new McpServer({ name: 'scinote-mcp', version: '0.1.0' });

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
});

function notImplemented(milestone: string): never {
  throw new Error(`Not implemented yet — this is your ${milestone} task. See README.md.`);
}

// ---------------------------------------------------------------------------
// Milestone 1 — read-only (implemented; use as reference for the others)
// ---------------------------------------------------------------------------

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
      tasks.map((t) => ({ id: t.id, name: t.attributes.name, state: t.attributes.state }))
    );
  }
);

server.tool(
  'get_task_steps',
  'Get protocol steps for a task, including checklists and per-item checked state. Use this to find checklist item ids before ticking.',
  { taskId: z.string().describe('Task id from list_tasks') },
  async ({ taskId }) => {
    const protocols = await scinote.listProtocols(taskId);
    if (protocols.length === 0) return text('Task has no protocol');
    const protocolId = protocols[0].id;
    const steps = await scinote.listSteps(taskId, protocolId);
    return text({
      protocolId,
      steps: steps.map((s) => ({
        id: s.id,
        name: s.attributes.name,
        position: s.attributes.position,
        completed: s.attributes.completed
      }))
    });
  }
);

// ---------------------------------------------------------------------------
// Milestone 2 — protocol execution writes
// The scinote.ts client methods exist; your job is to verify payloads against
// the Rails controllers, handle errors, and return tech-friendly confirmations.
// ---------------------------------------------------------------------------

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
  async () => notImplemented('Milestone 2')
);

server.tool(
  'complete_step',
  'Mark a protocol step (bench checkpoint) as completed — timestamps the checkpoint',
  { taskId: z.string(), protocolId: z.string(), stepId: z.string(), completed: z.boolean().default(true) },
  async () => notImplemented('Milestone 2')
);

// ---------------------------------------------------------------------------
// Milestone 3 — inventory assignment + stock consumption
// ---------------------------------------------------------------------------

server.tool(
  'list_task_items',
  'List inventory items assigned to a task, with current stock',
  { taskId: z.string() },
  async () => notImplemented('Milestone 3')
);

server.tool(
  'assign_item',
  'Assign an inventory item (e.g. an arm aliquot) to a task',
  { taskId: z.string(), inventoryItemId: z.string() },
  async () => notImplemented('Milestone 3')
);

server.tool(
  'consume_stock',
  'Log stock consumption (mL) for an item assigned to a task. Writes the inventory ledger. ALWAYS confirm amount and item name with the user before calling.',
  {
    taskId: z.string(),
    itemId: z.string().describe('The task item assignment id, not the inventory row id'),
    amount: z.number().positive(),
    comment: z.string().optional()
  },
  async () => notImplemented('Milestone 3')
);

// ---------------------------------------------------------------------------
// Milestone 4 — search + results
// ---------------------------------------------------------------------------

server.tool(
  'find_inventory_item',
  'Find inventory items by name fragment (e.g. "A1 aliquot") and report stock levels',
  { inventoryId: z.string(), query: z.string() },
  async () => notImplemented('Milestone 4')
);

server.tool(
  'add_result_note',
  'Add a text result to a task (e.g. Z-stack folder path, deviations)',
  { taskId: z.string(), name: z.string(), body: z.string() },
  async () => notImplemented('Milestone 4')
);

// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('scinote-mcp running on stdio');
