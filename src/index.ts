#!/usr/bin/env node
// Stdio entry point — for local MCP clients (Inspector, editor integrations)
// that launch the server as a child process. For the hosted HTTP endpoint see
// src/http.ts.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { requireLocalCredential } from './config.js';
import { createServer } from './server.js';

requireLocalCredential();

await createServer().connect(new StdioServerTransport());
console.error('scinote-mcp running on stdio');
