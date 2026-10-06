import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";

// Codex's JsonSchema.items is one schema, not draft-7's array of tuple schemas:
// https://github.com/openai/codex/blob/main/codex-rs/tools/src/json_schema/types.rs
// Check the actual tools/list payload, including schemas nested in unions and refs.
export function assertCodexCompatibleItems(result) {
  const { tools } = ListToolsResultSchema.parse(result);
  function visit(schema, path) {
    if (!schema || typeof schema !== "object") return;
    assert.ok(!Array.isArray(schema.items), `${path}.items: Codex requires a single schema; use a fixed-length homogeneous array for numeric tuples`);
    if (schema.items) visit(schema.items, `${path}.items`);
    for (const key of ["properties", "$defs", "definitions"]) {
      for (const [name, child] of Object.entries(schema[key] ?? {})) visit(child, `${path}.${key}.${name}`);
    }
    for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
      for (const [index, child] of (schema[key] ?? []).entries()) visit(child, `${path}.${key}[${index}]`);
    }
    if (typeof schema.additionalProperties === "object") visit(schema.additionalProperties, `${path}.additionalProperties`);
  }
  for (const tool of tools) visit(tool.inputSchema, tool.name);
}

// Also usable against a saved SDK result or a raw stdio tools/list response.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const payload = JSON.parse(await readFile(process.argv[2], "utf8"));
  const result = payload.result ?? payload;
  assertCodexCompatibleItems(result);
  console.log(`ok ${result.tools.length} MCP schemas expose single-schema items`);
}
