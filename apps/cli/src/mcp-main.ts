import { serveMcp } from './mcp.ts';

// `bt mcp` without the rest of bt, so the MCP server an agent starts is up fast. The desktop
// app's bundle builds mcp.mjs from this file.
serveMcp();
