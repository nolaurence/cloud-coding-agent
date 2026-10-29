export function isPreReleaseHost(host: string): boolean {
  return host.trim().toLowerCase().startsWith("pre");
}
