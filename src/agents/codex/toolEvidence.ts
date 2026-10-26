import { isDeepStrictEqual } from 'node:util';
import type { AtifContent, JsonObject } from '../../atif/index.ts';
import { assertBoundedJsonValue } from '../../atif/parser.ts';
import type { AgentNativeEvidenceWarning } from '../../contracts/agent.ts';
import { isSafeSimpleIdentifier } from '../../model/paths.ts';
import { nativeJsonValue } from './nativeJson.ts';
import { codexTruncationBudget } from './truncation.ts';

type NativeObject = Record<string, unknown>;
type NativeOutputBlock =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: string };

const CODEX_MCP_RESOURCE_LIST_TOOLS: readonly string[] = [
  'list_mcp_resources',
  'list_mcp_resource_templates',
];

const IMAGE_OMITTED =
  '[Codex image content retained only in the native artifact.]';
const IMAGE_DECODE_OMITTED =
  'image content omitted because it could not be processed';
const MCP_OUTPUT_HEADER = /^Wall time: [0-9]+(?:\.[0-9]+)? seconds\nOutput:/;

/** Known native tool shapes which cannot be normalized faithfully fail closed. */
export class CodexToolEvidenceError extends Error {}

/**
 * Native inline images are not ATIF file references. Preserve their position
 * explicitly without fabricating a path or exposing data URLs to a judge.
 */
export function normalizeCodexToolOutput(
  value: unknown,
  warnings: AgentNativeEvidenceWarning[],
  recordIndex: number,
): AtifContent {
  const output = validateToolOutput(value);
  if (typeof output === 'string') return output;
  return output.map((block, index) => {
    if (block.type === 'input_text') return { type: 'text', text: block.text };
    warnings.push({
      code: 'value_omitted',
      message:
        'Codex image content was retained only in the restricted native artifact.',
      path: `line:${recordIndex + 1}.output[${index}]`,
    });
    return { type: 'text', text: IMAGE_OMITTED };
  });
}

export function codexToolSearchArguments(payload: NativeObject): JsonObject {
  requireCompletedSearch(payload);
  const arguments_ = object(payload.arguments);
  onlyKeys(arguments_, ['query', 'limit']);
  nonempty(arguments_.query);
  if (
    arguments_.limit !== undefined &&
    (!Number.isSafeInteger(arguments_.limit) ||
      (arguments_.limit as number) <= 0)
  )
    fail();
  return arguments_ as JsonObject;
}

export function codexToolSearchOutput(payload: NativeObject): string {
  requireCompletedSearch(payload);
  for (const definition of array(payload.tools)) {
    const namespace = object(definition);
    onlyKeys(namespace, ['type', 'name', 'description', 'tools']);
    if (namespace.type !== 'namespace') fail();
    nonempty(namespace.name);
    if (namespace.description !== undefined) string(namespace.description);
    for (const entry of array(namespace.tools)) {
      const tool = object(entry);
      onlyKeys(tool, [
        'type',
        'name',
        'description',
        'strict',
        'defer_loading',
        'parameters',
      ]);
      if (tool.type !== 'function') fail();
      nonempty(tool.name);
      if (tool.description !== undefined) string(tool.description);
      if (tool.strict !== undefined) boolean(tool.strict);
      if (tool.defer_loading !== undefined) boolean(tool.defer_loading);
      object(tool.parameters);
    }
  }
  // Tool definitions are observable discovery results, not recorder metadata.
  return JSON.stringify({ tools: payload.tools });
}

/** Validate the MCP recorder mirror before borrowing its tool-error status. */
export function validateCodexMcpSnapshot(
  item: NativeObject,
  call: NativeObject,
  output: NativeObject,
  rawRecord: string,
): { isError: boolean; truncated: boolean } {
  onlyKeys(item, [
    'type',
    'id',
    'server',
    'tool',
    'arguments',
    'readOnlyHint',
    'pluginId',
    'status',
    'result',
    'error',
    'duration',
  ]);
  const server = nonempty(item.server);
  const tool = nonempty(item.tool);
  if (
    item.type !== 'McpToolCall' ||
    call.type !== 'function_call' ||
    output.type !== 'function_call_output' ||
    item.id !== call.call_id ||
    item.id !== output.call_id
  )
    fail();
  const namespaced = call.namespace === `mcp__${server}` && call.name === tool;
  const qualified =
    (call.namespace === undefined || call.namespace === '') &&
    call.name === `mcp__${server}__${tool}`;
  const unqualified =
    (call.namespace === undefined || call.namespace === '') &&
    call.name === tool &&
    CODEX_MCP_RESOURCE_LIST_TOOLS.includes(tool);
  if (!namespaced && !qualified && !unqualified) fail();
  const arguments_: unknown = JSON.parse(string(call.arguments));
  assertBoundedJsonValue(arguments_);
  if (!isDeepStrictEqual(object(item.arguments), object(arguments_))) fail();
  if (item.readOnlyHint !== undefined) boolean(item.readOnlyHint);
  // The pinned CLI attaches the qualified plugin identity to plugin MCP calls.
  if (item.pluginId !== undefined) {
    const parts = nonempty(item.pluginId).split('@');
    if (parts.length !== 2 || !parts.every(isSafeSimpleIdentifier)) fail();
  }
  validateDuration(item.duration);

  let failed: boolean;
  let expectedContent: NativeObject[];
  let structuredContent: NativeObject | undefined;
  if (item.error !== undefined && item.error !== null) {
    const error = object(item.error);
    onlyKeys(error, ['message']);
    if (item.result !== undefined && item.result !== null) fail();
    failed = true;
    expectedContent = [{ type: 'text', text: string(error.message) }];
  } else {
    const result = object(item.result);
    onlyKeys(result, ['content', 'structuredContent', 'isError']);
    failed = result.isError === undefined ? false : boolean(result.isError);
    expectedContent = array(result.content).map((part) => {
      const block = object(part);
      if (block.type === 'text') {
        onlyKeys(block, ['type', 'text', 'annotations', '_meta']);
        string(block.text);
      } else if (block.type === 'image') {
        onlyKeys(block, ['type', 'data', 'mimeType', 'annotations', '_meta']);
        validateInlineImage(
          `data:${string(block.mimeType)};base64,${nonempty(block.data)}`,
        );
      } else fail();
      // These extension objects are opaque tool data, not Forge control fields.
      // The rollout parser already bounds the complete snapshot's JSON graph.
      if (block.annotations !== undefined) object(block.annotations);
      if (block._meta !== undefined) object(block._meta);
      return block;
    });
    if (result.structuredContent !== undefined)
      structuredContent = object(result.structuredContent);
  }
  // 0.149.0 reports tool-level isError and RPC errors as failed snapshots;
  // a completed call record alone never proves successful tool execution.
  if (item.status !== (failed ? 'failed' : 'completed')) fail();
  if (output.is_error !== undefined && boolean(output.is_error) !== failed)
    fail();
  const rawContent = () => {
    const path = ['payload', 'item'];
    if (item.error !== undefined && item.error !== null) {
      const message = nativeJsonValue(rawRecord, [...path, 'error', 'message']);
      return message === undefined
        ? undefined
        : `[{"type":"text","text":${message}}]`;
    }
    return nativeJsonValue(rawRecord, [
      ...path,
      'result',
      structuredContent === undefined ? 'content' : 'structuredContent',
    ]);
  };
  if (unqualified) {
    if (
      structuredContent !== undefined ||
      expectedContent.length !== 1 ||
      expectedContent[0]?.type !== 'text' ||
      output.output !== expectedContent[0].text
    )
      fail();
    return { isError: failed, truncated: false };
  }
  const truncated = validateMcpOutputMirror(
    output.output,
    expectedContent,
    structuredContent,
    rawContent,
  );
  return { isError: failed, truncated };
}

function validateMcpOutputMirror(
  value: unknown,
  content: readonly NativeObject[],
  structured: NativeObject | undefined,
  rawContent: () => string | undefined,
): boolean {
  const output = validateToolOutput(value);
  if (typeof output === 'string') {
    const header = MCP_OUTPUT_HEADER.exec(output)?.[0];
    if (!header || output[header.length] !== '\n') fail();
    // The CLI chooses structuredContent when present; otherwise it serializes
    // text MCP blocks. Image blocks use the separate native array form.
    if (
      structured === undefined &&
      content.some((block) => block.type === 'image')
    )
      fail();
    // Preserve ordinary semantic equality (including literal marker text).
    // A legitimate clip can cut a JSON escape, so parsing the body is optional
    // only when the exact truncation can be proven from the raw snapshot span.
    let body: unknown;
    try {
      body = JSON.parse(output.slice(header.length + 1));
    } catch {
      /* Try a validated clip below. */
    }
    if (body !== undefined) {
      assertBoundedJsonValue(body);
      if (isDeepStrictEqual(body, structured ?? content)) return false;
    }
    const original = rawContent();
    if (
      original !== undefined &&
      codexTruncationBudget(`${header}\n${original}`, output) !== undefined
    )
      return true;
    fail();
  }
  if (
    structured !== undefined ||
    output[0]?.type !== 'input_text' ||
    MCP_OUTPUT_HEADER.exec(output[0].text)?.[0] !== output[0].text
  )
    fail();
  // Arrays spend one shared text budget in order: a clipped block exhausts it;
  // later text blocks (even empty ones) are dropped, while images survive.
  let cursor = 1;
  let exhausted = false;
  let truncated = false;
  let omitted = 0;
  let trailingEmptyText = false;
  for (const [index, block] of content.entries()) {
    const rendered = output[cursor];
    if (block.type === 'image' && rendered?.type === 'input_image') {
      // Images can be re-encoded by the CLI. Their bytes are deliberately not
      // treated as judge-visible evidence; only the matched image position is.
      validateImageUrl(rendered.image_url);
      cursor += 1;
      continue;
    }
    const expected =
      block.type === 'text' ? string(block.text) : IMAGE_DECODE_OMITTED;
    if (exhausted) {
      omitted += 1;
      continue;
    }
    if (rendered?.type === 'input_text' && rendered.text === expected) {
      // A source block can itself equal the final omission marker. If literal
      // matching would leave unmatched source blocks, validate it as the marker
      // for that entire tail instead. No later image can have survived here.
      const tailCount = content.length - index;
      if (
        tailCount > 1 &&
        cursor === output.length - 1 &&
        !trailingEmptyText &&
        rendered.text === `[omitted ${tailCount} text items ...]`
      ) {
        omitted = tailCount;
        break;
      }
      trailingEmptyText = expected.length === 0;
      cursor += 1;
      continue;
    }
    if (
      rendered?.type === 'input_text' &&
      codexTruncationBudget(expected, rendered.text) !== undefined
    ) {
      truncated = true;
      cursor += 1;
    } else {
      // The budget can also end exactly at a text boundary. Empty strings
      // following that boundary would already have been omitted, not retained.
      if (trailingEmptyText) fail();
      omitted += 1;
    }
    exhausted = true;
  }
  if (omitted > 0) {
    const marker = output[cursor++];
    if (
      marker?.type !== 'input_text' ||
      marker.text !== `[omitted ${omitted} text items ...]`
    )
      fail();
  }
  if (cursor !== output.length) fail();
  return truncated || omitted > 0;
}

function validateToolOutput(value: unknown): string | NativeOutputBlock[] {
  if (typeof value === 'string') return value;
  return array(value).map((part) => {
    const block = object(part);
    if (block.type === 'input_text') {
      onlyKeys(block, ['type', 'text']);
      return { type: 'input_text', text: string(block.text) };
    }
    if (block.type !== 'input_image') fail();
    onlyKeys(block, ['type', 'image_url', 'detail']);
    const url = nonempty(block.image_url);
    validateImageUrl(url);
    if (
      block.detail !== undefined &&
      block.detail !== 'auto' &&
      block.detail !== 'low' &&
      block.detail !== 'high'
    )
      fail();
    return {
      type: 'input_image',
      image_url: url,
      ...(block.detail === undefined ? {} : { detail: string(block.detail) }),
    };
  });
}

function validateImageUrl(value: string): void {
  if (value.startsWith('data:')) {
    validateInlineImage(value);
    return;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail();
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    fail();
  // References are omitted too: no fetch, fabricated path, or URL disclosure.
}

function validateInlineImage(value: string): void {
  if (
    !/^data:image\/(?:png|jpeg|gif|webp);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    ) ||
    value.endsWith(',')
  )
    fail();
}

function requireCompletedSearch(payload: NativeObject): void {
  if (payload.status !== 'completed' || payload.execution !== 'client') fail();
}

function validateDuration(value: unknown): void {
  const duration = object(value);
  onlyKeys(duration, ['secs', 'nanos']);
  if (
    !Number.isSafeInteger(duration.secs) ||
    (duration.secs as number) < 0 ||
    !Number.isSafeInteger(duration.nanos) ||
    (duration.nanos as number) < 0 ||
    (duration.nanos as number) >= 1_000_000_000
  )
    fail();
}

function onlyKeys(value: NativeObject, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail();
}
function object(value: unknown): NativeObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail();
  return value as NativeObject;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) fail();
  return value;
}
function string(value: unknown): string {
  if (typeof value !== 'string') fail();
  return value;
}
function nonempty(value: unknown): string {
  const text = string(value);
  if (!text) fail();
  return text;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') fail();
  return value;
}
function fail(): never {
  throw new CodexToolEvidenceError(
    'Codex native tool evidence is incomplete or unsupported.',
  );
}
