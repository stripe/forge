/** Match Forge's host-provider loopback rule, plus OpenCode's local Docker bridge. */
export function isLocalOpenCodeHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '[::1]' ||
    normalized === '::1' ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(normalized) ||
    normalized === 'host.docker.internal'
  );
}
