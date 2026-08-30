// End-to-end smoke test: launches the MCP server over stdio and calls tools the
// way Ozwell will. Run with `npm run smoke -- <tool> '<json args>'`, or with no
// arguments to list the registered tools.
//
// Examples:
//   npm run smoke
//   npm run smoke -- get_task_steps '{"taskId":"970"}'
//   npm run smoke -- consume_stock '{"taskId":"970","itemId":"63","amount":20}'

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [tool, rawArgs] = process.argv.slice(2);

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['tsx', 'src/index.ts'],
  stderr: 'inherit'
});
const client = new Client({ name: 'smoke', version: '0.1.0' });
await client.connect(transport);

if (!tool) {
  const { tools } = await client.listTools();
  for (const t of tools) console.log(`${t.name.padEnd(22)} ${t.description}`);
} else {
  const result = await client.callTool({
    name: tool,
    arguments: rawArgs ? JSON.parse(rawArgs) : {}
  });
  const content = result.content as Array<{ type: string; text?: string }>;
  for (const part of content) console.log(part.text ?? JSON.stringify(part));
  if (result.isError) process.exitCode = 1;
}

await client.close();
