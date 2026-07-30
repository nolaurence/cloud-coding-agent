import type { GitLogCommit } from "@cca/protocol";

export interface GitGraphRow {
  commit: GitLogCommit;
  lane: number;
  parentLanes: number[];
  activeLanes: number[];
}

export function layoutGitGraph(commits: readonly GitLogCommit[]): GitGraphRow[] {
  const lanes: Array<string | null> = [];
  const rows: GitGraphRow[] = [];

  const reserveLane = (hash: string) => {
    const reusable = lanes.indexOf(null);
    if (reusable >= 0) {
      lanes[reusable] = hash;
      return reusable;
    }
    lanes.push(hash);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    const claims = lanes.flatMap((hash, lane) => hash === commit.hash ? [lane] : []);
    const lane = claims[0] ?? reserveLane(commit.hash);
    const activeBefore = lanes.flatMap((hash, index) => hash === null ? [] : [index]);

    for (const claimedLane of claims) lanes[claimedLane] = null;

    const parentLanes = commit.parents.map((parent, index) => {
      if (index === 0) {
        lanes[lane] = parent;
        return lane;
      }
      const existing = lanes.indexOf(parent);
      return existing >= 0 ? existing : reserveLane(parent);
    });
    if (commit.parents.length === 0) lanes[lane] = null;

    while (lanes.at(-1) === null) lanes.pop();
    const activeAfter = lanes.flatMap((hash, index) => hash === null ? [] : [index]);
    rows.push({
      commit,
      lane,
      parentLanes,
      activeLanes: [...new Set([...activeBefore, lane, ...activeAfter])].sort((a, b) => a - b),
    });
  }

  return rows;
}
