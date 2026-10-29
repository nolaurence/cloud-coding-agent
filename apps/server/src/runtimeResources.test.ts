import assert from "node:assert/strict";
import test from "node:test";
import { aggregatePodResources, parseResourceQuantity, readCgroupResources, ResourceSampler } from "./runtimeResources.js";

function reader(files: Record<string, string>) {
  return async (file: string) => {
    const value = files[file];
    if (value === undefined) throw new Error("not found");
    return value;
  };
}

function v2Files() {
  return {
    "/proc/self/cgroup": "0::/\n",
    "/sys/fs/cgroup/memory.current": "536870912\n",
    "/sys/fs/cgroup/memory.max": "1073741824\n",
    "/sys/fs/cgroup/cpu.stat": "usage_usec 1000000\nuser_usec 500000\n",
    "/sys/fs/cgroup/cpu.max": "200000 100000\n",
    "/sys/fs/cgroup/cpuset.cpus.effective": "0-7\n",
  };
}

test("resource quantities support Kubernetes CPU, binary memory and decimal notation", () => {
  assert.equal(parseResourceQuantity("250m"), 0.25);
  assert.equal(parseResourceQuantity("500000000n"), 0.5);
  assert.ok(Math.abs(parseResourceQuantity("25u") - 0.000025) < 1e-12);
  assert.equal(parseResourceQuantity("512Mi"), 536870912);
  assert.equal(parseResourceQuantity("1.5Gi"), 1610612736);
  assert.equal(parseResourceQuantity("1e3"), 1000);
  for (const invalid of ["", "-1", "NaN", "1Watts"]) assert.throws(() => parseResourceQuantity(invalid));
});

test("cgroup v2 uses quotas and the current cgroup rather than host totals", async () => {
  const sample = await readCgroupResources(reader(v2Files()));
  assert.equal(sample?.cpuUsage, 1);
  assert.equal(sample?.cpuLimit, 2);
  assert.equal(sample?.memoryUsed, 536870912);
  assert.equal(sample?.memoryLimit, 1073741824);
  const files: Record<string, string> = { ...v2Files(), "/proc/self/cgroup": "0::/nested\n",
    "/sys/fs/cgroup/nested/memory.current": "123", "/sys/fs/cgroup/nested/memory.max": "max",
    "/sys/fs/cgroup/nested/cpu.max": "max 100000", "/sys/fs/cgroup/nested/cpuset.cpus.effective": "0-1,4" };
  const nested = await readCgroupResources(reader(files));
  assert.equal(nested?.memoryUsed, 123);
  assert.equal(nested?.memoryLimit, null);
  assert.equal(nested?.cpuLimit, 3);
});

test("cgroup v1 handles separate CPU accounting and quota controllers", async () => {
  const sample = await readCgroupResources(reader({
    "/proc/self/cgroup": "3:memory:/\n4:cpu:/\n5:cpuacct:/\n",
    "/sys/fs/cgroup/memory/memory.usage_in_bytes": "1024",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712",
    "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "150000",
    "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000",
    "/sys/fs/cgroup/cpuacct/cpuacct.usage": "3000000000",
  }));
  assert.equal(sample?.source, "cgroup v1");
  assert.equal(sample?.cpuUsage, 3);
  assert.equal(sample?.cpuLimit, 1.5);
  assert.equal(sample?.memoryLimit, null);
});

test("resource sampler caches concurrent clients and calculates CPU deltas", async () => {
  let now = 10_000;
  let podCalls = 0;
  const files = v2Files();
  const sampler = new ResourceSampler({ read: reader(files), now: () => now, pod: async () => { podCalls += 1; return null; } });
  const [first, simultaneous] = await Promise.all([sampler.read(), sampler.read()]);
  assert.strictEqual(first, simultaneous);
  assert.equal(podCalls, 1);
  assert.equal(first.cpuPercent, null);
  assert.equal(first.memoryPercent, 50);
  now += 1000;
  assert.strictEqual(await sampler.read(), first);
  now += 3000;
  files["/sys/fs/cgroup/cpu.stat"] = "usage_usec 3000000\n";
  const second = await sampler.read();
  assert.equal(second.cpuCores, 0.5);
  assert.equal(second.cpuPercent, 25);
  assert.equal(second.scope, "container");
});

test("Pod resources aggregate all containers and never invent missing limits", () => {
  const metrics = { containers: [{ name: "app", usage: { cpu: "500m", memory: "256Mi" } }, { name: "worker", usage: { cpu: "250m", memory: "128Mi" } }], timestamp: "2026-10-28T00:00:00Z" };
  const pod = { spec: { containers: [{ name: "app", resources: { limits: { cpu: "1", memory: "512Mi" } } }, { name: "worker", resources: { limits: { cpu: "1", memory: "512Mi" } } }] } };
  const resources = aggregatePodResources(metrics, pod, "test-pod", 123);
  assert.equal(resources.scope, "pod");
  assert.equal(resources.cpuCores, 0.75);
  assert.equal(resources.cpuPercent, 37.5);
  assert.equal(resources.memoryPercent, 37.5);
  assert.equal(resources.sampledAt, Date.parse(metrics.timestamp));
  const unlimited = aggregatePodResources(metrics, { spec: { containers: [{ name: "app" }, { name: "worker" }] } }, "test", 123);
  assert.equal(unlimited.cpuLimitCores, null);
  assert.equal(unlimited.memoryPercent, null);
  assert.throws(() => aggregatePodResources({ containers: [metrics.containers[0]] }, pod, "test", 123), /不完整/);
});

test("an inaccessible metrics API falls back to cgroup with bounded retries", async () => {
  let now = 10_000;
  let calls = 0;
  const sampler = new ResourceSampler({ now: () => now, read: reader(v2Files()), pod: async () => { calls += 1; throw new Error("forbidden"); } });
  assert.equal((await sampler.read()).scope, "container");
  now += 5000;
  assert.equal((await sampler.read()).scope, "container");
  assert.equal(calls, 1);
  now += 60_000;
  await sampler.read();
  assert.equal(calls, 2);
});
