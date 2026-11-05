import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

export const MODEL = 'claude-sonnet-4-6';
export const CODEX_MODEL = 'gpt-5.4';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;

export function readLiveConfiguration(environment, repositoryRoot) {
  if (environment.FORGE_LIVE !== '1') {
    throw new Error(
      'The live suite uses Docker; full mode makes potentially billable model calls. Set FORGE_LIVE=1 to opt in.',
    );
  }

  const mode = optionalEnvironment('FORGE_LIVE_MODE') ?? 'full';
  if (mode !== 'full' && mode !== 'setup' && mode !== 'completions') {
    throw new Error('FORGE_LIVE_MODE must be full or setup or completions.');
  }
  // Host completion coverage uses a scripted agent and needs no Docker or agent key.
  if (mode === 'completions') {
    return Object.freeze({
      mode,
      completionModel: requiredEnvironment('FORGE_LIVE_COMPLETION_MODEL'),
      upstreamCredential: requiredEnvironment('OPENAI_API_KEY'),
      gatewayBaseUrl: optionalEnvironment('OPENAI_BASE_URL'),
      resultsRoot: path.resolve(
        repositoryRoot,
        optionalEnvironment('FORGE_LIVE_RESULTS_ROOT') ?? 'results/live',
      ),
      suiteId: liveSuiteId(optionalEnvironment('FORGE_LIVE_RUN_ID')),
      timeoutMs: positiveIntegerEnvironment(
        'FORGE_LIVE_TIMEOUT_MS',
        DEFAULT_TIMEOUT_MS,
      ),
    });
  }
  const liveAgent = optionalEnvironment('FORGE_LIVE_AGENT') ?? 'claude-code';
  if (!['claude-code', 'codex', 'opencode'].includes(liveAgent)) {
    throw new Error(
      'FORGE_LIVE_AGENT must be claude-code, codex, or opencode.',
    );
  }
  if (liveAgent === 'opencode' && mode !== 'setup')
    throw new Error(
      'OpenCode live coverage currently requires FORGE_LIVE_MODE=setup.',
    );
  const codexSelected = liveAgent === 'codex';
  const gatewayEnvironmentName = codexSelected
    ? 'OPENAI_BASE_URL'
    : 'ANTHROPIC_BASE_URL';
  const gatewayBaseUrl =
    mode === 'setup' ? undefined : optionalEnvironment(gatewayEnvironmentName);
  const gatewaySelected = gatewayBaseUrl !== undefined;
  const credentialEnvironmentName = codexSelected
    ? 'CODEX_API_KEY'
    : gatewaySelected
      ? 'ANTHROPIC_AUTH_TOKEN'
      : 'ANTHROPIC_API_KEY';
  const upstreamCredential =
    mode === 'setup'
      ? undefined
      : requiredEnvironment(credentialEnvironmentName);
  const timeoutMs = positiveIntegerEnvironment(
    'FORGE_LIVE_TIMEOUT_MS',
    DEFAULT_TIMEOUT_MS,
  );
  const dockerExecutable =
    optionalEnvironment('FORGE_DOCKER_EXECUTABLE') ?? 'docker';
  const resultsRoot = path.resolve(
    repositoryRoot,
    optionalEnvironment('FORGE_LIVE_RESULTS_ROOT') ?? 'results/live',
  );
  const suiteId = liveSuiteId(optionalEnvironment('FORGE_LIVE_RUN_ID'));
  const runIds = Object.freeze({
    docker: `${suiteId}-docker`,
    plugin: `${suiteId}-plugin`,
    oneShot: `${suiteId}-one-shot`,
    multiTurn: `${suiteId}-multi-turn`,
  });
  return Object.freeze({
    mode,
    liveAgent,
    codexSelected,
    gatewayEnvironmentName,
    gatewayBaseUrl,
    gatewaySelected,
    credentialEnvironmentName,
    upstreamCredential,
    timeoutMs,
    dockerExecutable,
    repositoryRoot,
    resultsRoot,
    suiteId,
    runIds,
  });

  function liveSuiteId(configured) {
    const value = configured ?? `live-e2e-${randomUUID()}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value)) {
      throw new TypeError(
        'FORGE_LIVE_RUN_ID must be a safe identifier of at most 96 characters.',
      );
    }
    return value;
  }

  function requiredEnvironment(name) {
    const value = optionalEnvironment(name);
    if (value === undefined) {
      throw new Error(`${name} is required for the live suite.`);
    }
    return value;
  }

  function optionalEnvironment(name) {
    const value = environment[name];
    if (value === undefined || value.length === 0) return undefined;
    if (value.includes('\0')) {
      throw new TypeError(`${name} must not contain a NUL byte.`);
    }
    return value;
  }

  function positiveIntegerEnvironment(name, fallback) {
    const value = optionalEnvironment(name);
    if (value === undefined) return fallback;
    if (!/^[1-9][0-9]*$/.test(value)) {
      throw new TypeError(`${name} must be a positive integer.`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new TypeError(`${name} must be a safe integer.`);
    }
    return parsed;
  }
}

export function parseGatewayUrl(value, environmentName = 'ANTHROPIC_BASE_URL') {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${environmentName} must be a valid HTTP(S) URL.`);
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new TypeError(
      `${environmentName} must be a credential-free HTTP(S) URL without a query or fragment.`,
    );
  }
  return parsed;
}

export function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '[::1]' ||
    normalized === '::1' ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(normalized)
  );
}
