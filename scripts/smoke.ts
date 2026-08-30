// End-to-end smoke test: launches the MCP server over stdio and calls tools the
// way Ozwell will. Run with `npm run smoke -- <tool> '<json args>'`, or with no
// arguments to list the registered tools.
//
// Several tool/args pairs run against one server process, which is how you set
// the working scope before a scoped call:
//   npm run smoke
//   npm run smoke -- set_scope '{"team":"Test","project":"GingiGuard","experiment":"Assay"}' list_tasks
//   npm run smoke -- set_scope '{...}' get_task_steps '{"taskId":"970"}'

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const argv = process.argv.slice(2);
const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
while (argv.length) {
  const name = argv.shift()!;
  const next = argv[0];
  calls.push({ name, args: next?.trimStart().startsWith('{') ? JSON.parse(argv.shift()!) : {} });
}

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['tsx', 'src/index.ts'],
  stderr: 'inherit'
});
const client = new Client({ name: 'smoke', version: '0.1.0' });
await client.connect(transport);

if (calls.length === 0) {
  const { tools } = await client.listTools();
  for (const t of tools) console.log(`${t.name.padEnd(22)} ${t.description}`);
} else {
  for (const call of calls) {
    console.log(`\n=== ${call.name} ===`);
    const result = await client.callTool({ name: call.name, arguments: call.args });
    const content = result.content as Array<{ type: string; text?: string }>;
    for (const part of content) console.log(part.text ?? JSON.stringify(part));
    if (result.isError) process.exitCode = 1;
  }
}

await client.close();
