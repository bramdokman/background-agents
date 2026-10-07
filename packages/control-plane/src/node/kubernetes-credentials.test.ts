import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readServiceAccountCredentials } from "./kubernetes-credentials";

describe("readServiceAccountCredentials", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
  });

  function serviceAccountDir(files: Record<string, string>): string {
    const directory = mkdtempSync(join(tmpdir(), "oi-sa-"));
    directories.push(directory);
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(directory, name), content);
    }
    return directory;
  }

  it("is absent outside a pod", () => {
    expect(readServiceAccountCredentials(serviceAccountDir({}))).toBeUndefined();
  });

  it("reports the pod's own namespace", () => {
    const credentials = readServiceAccountCredentials(
      serviceAccountDir({ token: "t1", namespace: "open-inspect\n" })
    );
    expect(credentials?.ownNamespace).toBe("open-inspect");
  });

  it("re-reads a rotated token after the reread interval, or at once on refresh", async () => {
    const directory = serviceAccountDir({ token: "first\n" });
    let nowMs = 0;
    const credentials = readServiceAccountCredentials(directory, () => nowMs)!;
    expect(await credentials.token()).toBe("first");

    writeFileSync(join(directory, "token"), "second");
    nowMs = 30_000;
    expect(await credentials.token()).toBe("first");
    expect(await credentials.token({ refresh: true })).toBe("second");

    writeFileSync(join(directory, "token"), "third");
    nowMs = 30_000 + 60_000;
    expect(await credentials.token()).toBe("third");
  });

  it("refuses an empty token", async () => {
    const credentials = readServiceAccountCredentials(serviceAccountDir({ token: "" }))!;
    await expect(credentials.token()).rejects.toThrow(/empty/);
  });
});
