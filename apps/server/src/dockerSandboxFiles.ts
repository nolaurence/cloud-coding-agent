import policy from "./dockerSandboxPolicy.json" with { type: "json" };

export const SANDBOX_WORKSPACE_POLICY_VERSION = policy.version;
const directories = new Set(policy.directories);
const files = new Set(policy.files);
const directoryPrefixes = policy.directoryPrefixes ?? [];

function matchesDirectoryPrefix(part: string): boolean {
  return directoryPrefixes.some((prefix) => part.startsWith(prefix));
}

/** Match at every depth: a workspace can contain several nested projects. */
export function isSandboxPathIgnored(name: string, directory = false): boolean {
  const parts = name.split("/");
  if (parts.some((part, index) => directories.has(part) || matchesDirectoryPrefix(part) ||
    ((directory || index < parts.length - 1) && policy.directorySuffixes.some(suffix => part.endsWith(suffix))))) return true;
  if (policy.paths.some(pattern => parts.some((_, index) => pattern.every((part, offset) => parts[index + offset] === part)))) return true;
  const basename = parts.at(-1)!;
  return !directory && (files.has(basename) || policy.fileSuffixes.some(suffix => basename.endsWith(suffix)) || basename.startsWith(".coverage."));
}
