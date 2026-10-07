// Runs the sandbox garbage collector's script (gc.sh in
// deploy/kubernetes/control-plane/gc-cronjob.yaml) against fixture pods and
// claims, with a fake kubectl that records what it is asked to do.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const cronJob = readFileSync(
  new URL("../deploy/kubernetes/control-plane/gc-cronjob.yaml", import.meta.url),
  "utf8"
);
const embedded = cronJob.match(/\n {2}gc\.sh: \|\n([\s\S]+?)\n---\n/)?.[1];
assert.ok(embedded, "gc.sh must stay a literal block in the GC ConfigMap");
const gcScript = embedded.replace(/^ {4}/gm, "");

const HOUR_MS = 3_600_000;
const NS = "open-inspect-sandboxes";

const FAKE_KUBECTL = `#!/usr/bin/env bash
set -eu
args=" $* "
log() { printf '%s\\n' "$*" >> "$FIXTURES/calls.log"; }
case "$args" in
  *" get pods -l app.kubernetes.io/managed-by=open-inspect -o json "*) cat "$FIXTURES/pods.json" ;;
  *" get pvc "*" -o json "*) cat "$FIXTURES/claims.json" ;;
  *" get pods -l openinspect.dev/sandbox="*" -o name "*) ;;
  *" annotate pvc "*"gc-claimed-at-ms-"*) log "release $5" ;;
  *" annotate pvc "*)
    if grep -qx "$5" "$FIXTURES/conflicts" 2>/dev/null; then exit 1; fi
    log "claim $5" ;;
  *" delete pod "*) log "delete pod $5" ;;
  *" delete pvc "*) log "delete pvc $5" ;;
  *) echo "unexpected kubectl call:$args" >&2; exit 2 ;;
esac
`;

function iso(msAgo) {
  return new Date(Date.now() - msAgo).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function sandboxPod(name, hash, { phase = "Running", startedAgo = HOUR_MS, status = {} } = {}) {
  return {
    metadata: {
      name,
      labels: { "openinspect.dev/sandbox": hash },
      creationTimestamp: iso(startedAgo),
    },
    spec: { volumes: [{ name: "workspace", persistentVolumeClaim: { claimName: `oi-${hash}` } }] },
    status: { phase, startTime: iso(startedAgo), ...status },
  };
}

function claim(hash, { createdAgo = HOUR_MS / 2, annotations = {} } = {}) {
  return {
    metadata: {
      name: `oi-${hash}`,
      resourceVersion: "1",
      labels: { "openinspect.dev/sandbox": hash },
      creationTimestamp: iso(createdAgo),
      annotations,
    },
  };
}

function ms(msAgo) {
  return String(Date.now() - msAgo);
}

function runGc({ pods = [], claims = [], conflicts = [] }) {
  const dir = mkdtempSync(join(tmpdir(), "oi-gc-"));
  try {
    writeFileSync(join(dir, "kubectl"), FAKE_KUBECTL);
    chmodSync(join(dir, "kubectl"), 0o755);
    writeFileSync(join(dir, "pods.json"), JSON.stringify({ items: pods }));
    writeFileSync(join(dir, "claims.json"), JSON.stringify({ items: claims }));
    writeFileSync(join(dir, "conflicts"), conflicts.join("\n"));
    writeFileSync(join(dir, "calls.log"), "");
    writeFileSync(join(dir, "gc.sh"), gcScript);
    const result = spawnSync("sh", [join(dir, "gc.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        FIXTURES: dir,
        SANDBOX_NAMESPACE: NS,
        RETENTION_HOURS: "168",
        DESTROY_GRACE_HOURS: "24",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(join(dir, "calls.log"), "utf8").split("\n").filter(Boolean);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const terminated = (finishedAgo) => ({
  containerStatuses: [
    { name: "sandbox", state: { terminated: { exitCode: 1, finishedAt: iso(finishedAgo) } } },
  ],
});

test("rule 1: an ended pod is kept for an hour after it ended, not after it started", () => {
  const live = [claim("a1"), claim("a2"), claim("a3")];
  const calls = runGc({
    claims: live,
    pods: [
      // Ran three hours, failed ten minutes ago: kept for debugging.
      sandboxPod("oi-a1-x", "a1", {
        phase: "Failed",
        startedAgo: 3 * HOUR_MS,
        status: terminated(10 * 60_000),
      }),
      sandboxPod("oi-a2-x", "a2", {
        phase: "Failed",
        startedAgo: 3 * HOUR_MS,
        status: terminated(2 * HOUR_MS),
      }),
      // No container state (evicted before it started): the Ready transition counts.
      sandboxPod("oi-a3-x", "a3", {
        phase: "Failed",
        startedAgo: 3 * HOUR_MS,
        status: {
          reason: "Evicted",
          conditions: [{ type: "Ready", status: "False", lastTransitionTime: iso(2 * HOUR_MS) }],
        },
      }),
    ],
  });
  assert.deepEqual(calls, ["delete pod oi-a2-x", "delete pod oi-a3-x"]);
});

test("rule 2: a pod whose claim is gone is deleted", () => {
  const calls = runGc({ pods: [sandboxPod("oi-b1-x", "b1")] });
  assert.deepEqual(calls, ["delete pod oi-b1-x"]);
});

test("rule 3: idle, released and partial claims go; preserved and busy ones stay", () => {
  const complete = { "openinspect.dev/create-complete-at-ms": ms(2 * HOUR_MS) };
  const calls = runGc({
    pods: [sandboxPod("oi-c6-x", "c6")],
    claims: [
      // A create that never finished, two hours ago.
      claim("c1", { createdAgo: 2 * HOUR_MS, annotations: {} }),
      // Preserve-stopped ten minutes ago, but its create-complete mark was lost.
      claim("c2", {
        createdAgo: 2 * HOUR_MS,
        annotations: {
          "openinspect.dev/stopped-at-ms": ms(10 * 60_000),
          "openinspect.dev/last-active-at-ms": ms(10 * 60_000),
        },
      }),
      // Destroyed 25 hours ago, and one destroyed an hour ago.
      claim("c3", {
        createdAgo: 30 * HOUR_MS,
        annotations: { ...complete, "openinspect.dev/destroy-requested-at-ms": ms(25 * HOUR_MS) },
      }),
      claim("c4", {
        createdAgo: 30 * HOUR_MS,
        annotations: { ...complete, "openinspect.dev/destroy-requested-at-ms": ms(HOUR_MS) },
      }),
      // Idle for eight days.
      claim("c5", {
        createdAgo: 9 * 24 * HOUR_MS,
        annotations: { ...complete, "openinspect.dev/last-active-at-ms": ms(8 * 24 * HOUR_MS) },
      }),
      // Old, but its sandbox is running.
      claim("c6", { createdAgo: 9 * 24 * HOUR_MS, annotations: {} }),
    ],
  });
  assert.deepEqual(calls, [
    "claim oi-c1",
    "delete pvc oi-c1",
    "claim oi-c3",
    "delete pvc oi-c3",
    "claim oi-c5",
    "delete pvc oi-c5",
  ]);
});

test("rule 3: a claim that changed since it was read is skipped", () => {
  const calls = runGc({
    claims: [claim("d1", { createdAgo: 2 * HOUR_MS })],
    conflicts: ["oi-d1"],
  });
  assert.deepEqual(calls, []);
});
