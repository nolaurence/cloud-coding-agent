import { readFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { RuntimeResources } from "@cca/protocol";

type ReadText = (file: string) => Promise<string>;
interface CpuSample { usage: number; at: number; scope: string }
interface CgroupSample { cpuUsage: number | null; cpuLimit: number | null; memoryUsed: number; memoryLimit: number | null; source: string }

export function parseResourceQuantity(value: string): number {
  const match = /^(\d+(?:\.\d+)?(?:e[+-]?\d+)?)([a-zA-Z]*)$/i.exec(value);
  const units: Record<string, number> = { "": 1, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
    Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6 };
  const factor = match ? units[match[2]!] : undefined;
  const result = match && factor !== undefined ? Number(match[1]) * factor : NaN;
  if (!Number.isFinite(result) || result < 0) throw new Error("资源指标格式无效");
  return result;
}

function finiteNumber(value: string | undefined): number | null {
  if (!value?.trim() || value.trim() === "max") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function cpusetSize(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  let count = 0;
  for (const range of value.trim().split(",")) {
    if (!/^\d+(?:-\d+)?$/.test(range)) return null;
    const [start, end = start] = range.split("-").map(Number);
    if (start === undefined || end === undefined || end < start) return null;
    count += end - start + 1;
  }
  return count > 0 ? count : null;
}

export async function readCgroupResources(read: ReadText = (file) => readFile(file, "utf8")): Promise<CgroupSample | null> {
  const optional = (file: string) => read(file).catch(() => undefined);
  const membership = await optional("/proc/self/cgroup");
  const entries = membership?.trim().split("\n").map((line) => line.split(":")) ?? [];
  const unified = entries.find((entry) => entry[1] === "")?.[2];
  const roots = [...new Set([unified ? path.join("/sys/fs/cgroup", unified) : "", "/sys/fs/cgroup"].filter(Boolean))];
  for (const root of roots) {
    const [memory, limit, stat, max, cpus] = await Promise.all([
      optional(`${root}/memory.current`), optional(`${root}/memory.max`), optional(`${root}/cpu.stat`),
      optional(`${root}/cpu.max`), optional(`${root}/cpuset.cpus.effective`),
    ]);
    const memoryUsed = finiteNumber(memory);
    if (memoryUsed === null) continue;
    const [quota, period] = max?.trim().split(/\s+/) ?? [];
    const quotaValue = finiteNumber(quota);
    const periodValue = finiteNumber(period);
    const quotaCores = quotaValue !== null && periodValue ? quotaValue / periodValue : null;
    const cpuset = cpusetSize(cpus);
    const cpuLimit = quotaCores === null ? cpuset : cpuset === null ? quotaCores : Math.min(quotaCores, cpuset);
    const usage = stat?.match(/^usage_usec\s+(\d+)$/m)?.[1];
    return { cpuUsage: usage ? Number(usage) / 1e6 : null, cpuLimit,
      memoryUsed, memoryLimit: finiteNumber(limit), source: "cgroup v2" };
  }
  const controllerRoot = (controller: string) => {
    const entry = entries.find((candidate) => candidate[1]?.split(",").includes(controller));
    return entry?.[2] && entry[2] !== "/" ? entry[2] : "";
  };
  for (const suffix of [...new Set([controllerRoot("memory"), ""])]) {
    const root = path.join("/sys/fs/cgroup/memory", suffix);
    const memoryUsed = finiteNumber(await optional(`${root}/memory.usage_in_bytes`));
    if (memoryUsed === null) continue;
    const memoryLimit = finiteNumber(await optional(`${root}/memory.limit_in_bytes`));
    let cpuUsage: number | null = null;
    let cpuLimit: number | null = null;
    for (const controller of ["cpu,cpuacct", "cpu", "cpuacct"]) {
      const cpuRoot = path.join(`/sys/fs/cgroup/${controller}`, controllerRoot("cpu"));
      const acctRoot = path.join(`/sys/fs/cgroup/${controller}`, controllerRoot("cpuacct"));
      const [usage, quota, period] = await Promise.all([
        optional(`${acctRoot}/cpuacct.usage`), optional(`${cpuRoot}/cpu.cfs_quota_us`), optional(`${cpuRoot}/cpu.cfs_period_us`),
      ]);
      cpuUsage ??= finiteNumber(usage);
      const quotaValue = finiteNumber(quota);
      const periodValue = finiteNumber(period);
      if (quotaValue !== null && periodValue) cpuLimit = quotaValue / periodValue;
    }
    return { cpuUsage: cpuUsage === null ? null : cpuUsage / 1e9, cpuLimit, memoryUsed,
      memoryLimit: memoryLimit !== null && memoryLimit < 2 ** 60 ? memoryLimit : null, source: "cgroup v1" };
  }
  return null;
}

function kubernetesJson(host: string, port: number, route: string, token: string, ca: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const request = https.get({ hostname: host, port, path: route, ca, headers: { Authorization: `Bearer ${token}` } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error("Pod 指标接口不可用"));
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 1_000_000) request.destroy(new Error("Pod 指标响应过大"));
      });
      response.on("error", reject);
      response.on("end", () => {
        try { resolve(JSON.parse(body) as Record<string, unknown>); }
        catch { reject(new Error("Pod 指标格式无效")); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error("Pod 指标请求超时")), 2500);
    request.on("close", () => clearTimeout(timer));
    request.on("error", reject);
  });
}

export function aggregatePodResources(metrics: Record<string, unknown>, pod: Record<string, unknown>, name: string, now: number): RuntimeResources {
  const containers = metrics.containers as { name: string; usage: { cpu: string; memory: string } }[];
  const specs = (pod.spec as { containers: { name: string; resources?: { limits?: { cpu?: string; memory?: string } } }[] }).containers;
  if (!Array.isArray(containers) || containers.length === 0 || specs.some((spec) => !containers.some((entry) => entry.name === spec.name))) {
    throw new Error("Pod 指标不完整");
  }
  const cpuCores = containers.reduce((total, entry) => total + parseResourceQuantity(entry.usage.cpu), 0);
  const memoryUsedBytes = containers.reduce((total, entry) => total + parseResourceQuantity(entry.usage.memory), 0);
  const cpuLimitCores = specs.every((entry) => entry.resources?.limits?.cpu)
    ? specs.reduce((total, entry) => total + parseResourceQuantity(entry.resources!.limits!.cpu!), 0) : null;
  const memoryLimitBytes = specs.every((entry) => entry.resources?.limits?.memory)
    ? specs.reduce((total, entry) => total + parseResourceQuantity(entry.resources!.limits!.memory!), 0) : null;
  const timestamp = typeof metrics.timestamp === "string" ? Date.parse(metrics.timestamp) : now;
  return { scope: "pod", name, cpuCores, cpuLimitCores, cpuPercent: cpuLimitCores ? cpuCores / cpuLimitCores * 100 : null,
    memoryUsedBytes, memoryLimitBytes, memoryPercent: memoryLimitBytes ? memoryUsedBytes / memoryLimitBytes * 100 : null,
    sampledAt: Number.isFinite(timestamp) ? timestamp : now, source: "Kubernetes Metrics API" };
}

async function readPodResources(): Promise<RuntimeResources | null> {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  if (!host) return null;
  const directory = "/var/run/secrets/kubernetes.io/serviceaccount";
  const [token, ca, namespace] = await Promise.all([
    readFile(`${directory}/token`, "utf8"), readFile(`${directory}/ca.crt`, "utf8"),
    process.env.POD_NAMESPACE ? Promise.resolve(process.env.POD_NAMESPACE) : readFile(`${directory}/namespace`, "utf8"),
  ]);
  const name = process.env.POD_NAME || os.hostname();
  const target = `namespaces/${encodeURIComponent(namespace.trim())}/pods/${encodeURIComponent(name)}`;
  const port = Number(process.env.KUBERNETES_SERVICE_PORT_HTTPS || 443);
  const [metrics, pod] = await Promise.all([
    kubernetesJson(host, port, `/apis/metrics.k8s.io/v1beta1/${target}`, token.trim(), ca),
    kubernetesJson(host, port, `/api/v1/${target}`, token.trim(), ca),
  ]);
  return aggregatePodResources(metrics, pod, name, Date.now());
}

export class ResourceSampler {
  private previous: CpuSample | undefined;
  private cached: RuntimeResources | undefined;
  private cacheAt = 0;
  private pending: Promise<RuntimeResources> | undefined;
  private retryPodAt = 0;

  constructor(private options: { read?: ReadText; pod?: () => Promise<RuntimeResources | null>; now?: () => number } = {}) {}

  read(): Promise<RuntimeResources> {
    const now = (this.options.now ?? Date.now)();
    if (this.cached && now - this.cacheAt < 3000) return Promise.resolve(this.cached);
    if (this.pending) return this.pending;
    this.pending = this.sample(now).then((value) => { this.cached = value; this.cacheAt = now; return value; }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async sample(now: number): Promise<RuntimeResources> {
    let notice: string | undefined;
    if (now >= this.retryPodAt) {
      try {
        const pod = await (this.options.pod ?? readPodResources)();
        if (pod) return pod;
      } catch { this.retryPodAt = now + 60_000; }
    }
    if (process.env.KUBERNETES_SERVICE_HOST) notice = "Pod 聚合指标不可用，以下仅统计应用所在容器，不含其他容器。";
    const cgroup = await readCgroupResources(this.options.read);
    let usage: number | null;
    let cpuLimit: number | null;
    let memoryUsed: number;
    let memoryLimit: number | null;
    let scope: "container" | "host";
    if (cgroup) {
      usage = cgroup.cpuUsage;
      cpuLimit = cgroup.cpuLimit;
      memoryUsed = cgroup.memoryUsed;
      memoryLimit = cgroup.memoryLimit;
      scope = "container";
    } else if (process.env.KUBERNETES_SERVICE_HOST) {
      return { scope: "unavailable", cpuCores: null, cpuLimitCores: null, cpuPercent: null,
        memoryUsedBytes: null, memoryLimitBytes: null, memoryPercent: null, sampledAt: now,
        source: "不可用", notice: "无法读取 Pod 或容器资源指标，请检查 Metrics Server、读取权限和 cgroup 挂载。" };
    } else {
      const processors = os.cpus();
      usage = processors.reduce((total, cpu) => total + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq, 0) / 1000;
      cpuLimit = processors.length || null;
      memoryUsed = os.totalmem() - os.freemem();
      memoryLimit = os.totalmem();
      scope = "host";
      notice = "当前不是可识别的容器环境，显示服务器整机用量，并非单个进程用量。";
    }
    const previous = this.previous;
    const sampledAt = (this.options.now ?? Date.now)();
    const cpuCores = usage !== null && previous && previous.scope === scope && sampledAt > previous.at && usage >= previous.usage
      ? (usage - previous.usage) / ((sampledAt - previous.at) / 1000) : null;
    this.previous = usage === null ? undefined : { usage, at: sampledAt, scope };
    return { scope, name: process.env.POD_NAME || os.hostname(), cpuCores, cpuLimitCores: cpuLimit,
      cpuPercent: cpuCores !== null && cpuLimit ? cpuCores / cpuLimit * 100 : null,
      memoryUsedBytes: memoryUsed, memoryLimitBytes: memoryLimit,
      memoryPercent: memoryLimit ? memoryUsed / memoryLimit * 100 : null,
      sampledAt, source: cgroup?.source ?? "操作系统", ...(notice ? { notice } : {}) };
  }
}

export const runtimeResourceSampler = new ResourceSampler();
