import { createHash } from 'node:crypto';

export const WEB_SEARCH_PLUGIN_PATH = 'forge-web-search.mjs';
// OpenCode ignores failed plugin hooks. A non-callable SDK setting prevents an
// untransformed request if the plugin fails to load or initialize.
export const WEB_SEARCH_TRANSFORM_REQUIRED = 'forge-web-search-required';

/** Dependency-free OpenCode config hook, shipped as bytes and copied into run-owned state. */
export const WEB_SEARCH_PLUGIN = `
export default async function (_input, options) {
  if (!options || Object.keys(options).length !== 1 ||
      !['native', 'exa'].includes(options.engine))
    throw new Error('Invalid Forge web search options.');
  const engine = options.engine;
  return {
    async config(config) {
      const provider = config.provider?.forge;
      if (provider?.npm !== '@ai-sdk/openai-compatible' || !provider.options ||
          provider.options.transformRequestBody !== '${WEB_SEARCH_TRANSFORM_REQUIRED}')
        throw new Error('Invalid Forge web search provider.');
      provider.options.transformRequestBody = (body) => {
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            typeof body.model !== 'string' || !body.model ||
            !Array.isArray(body.messages) || body.messages.length === 0 ||
            body.messages.some(message => !message || typeof message !== 'object' ||
              Array.isArray(message) || typeof message.role !== 'string') ||
            (body.tools !== undefined && (!Array.isArray(body.tools) ||
              body.tools.some(tool => !tool || tool.type !== 'function' ||
                !tool.function || typeof tool.function.name !== 'string' ||
                typeof tool.function.parameters !== 'object' ||
                tool.function.parameters === null || Array.isArray(tool.function.parameters)))))
          throw new Error('Invalid Forge web search request body.');
        return {
          ...body,
          tools: [...(body.tools ?? []), {
            type: 'openrouter:web_search', parameters: { engine },
          }],
        };
      };
    },
  };
}
`;

export const WEB_SEARCH_PLUGIN_SHA256 = createHash('sha256')
  .update(WEB_SEARCH_PLUGIN)
  .digest('hex');
