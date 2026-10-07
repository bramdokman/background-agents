// Static checks on the sandbox egress proxy's Squid config
// (deploy/kubernetes/sandboxes/squid.conf). Squid evaluates http_access rules
// in order, and a rule that uses a dst ACL makes it resolve the requested
// name first. If such a rule ran before the allowlist, any name a sandbox
// asks for would reach the public resolvers, and through them the name's
// authoritative server: a DNS exfiltration channel past the allowlist.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const conf = readFileSync(
  new URL("../deploy/kubernetes/sandboxes/squid.conf", import.meta.url),
  "utf8"
);
const lines = conf
  .split("\n")
  .map((line) => line.replace(/#.*/, "").trim())
  .filter(Boolean);

// ACL types whose evaluation resolves the destination name.
const RESOLVING_TYPES = new Set(["dst", "dst_as", "dstdomain_regex_resolve"]);
const BUILTIN_RESOLVING = new Set(["to_localhost", "to_linklocal", "to_linklocal6"]);

const acls = new Map();
for (const line of lines) {
  const [keyword, name, type, ...rest] = line.split(/\s+/);
  if (keyword === "acl") acls.set(name, { type, flags: rest.filter((p) => p.startsWith("-")) });
}
const resolving = (name) =>
  BUILTIN_RESOLVING.has(name) || RESOLVING_TYPES.has(acls.get(name)?.type);
const rules = lines
  .filter((line) => line.startsWith("http_access "))
  .map((line) => {
    const [, action, ...names] = line.split(/\s+/);
    return { line, action, names: names.map((n) => n.replace(/^!/, "")) };
  });

test("the allowlist matches names without resolving them", () => {
  const allowlist = acls.get("allowlist");
  assert.ok(allowlist, "an allowlist ACL is declared");
  assert.equal(allowlist.type, "dstdomain");
  assert.ok(allowlist.flags.includes("-n"), "dstdomain -n: no reverse lookup of IP literals");
});

test("names off the allowlist are denied before any rule that resolves", () => {
  const gate = rules.findIndex((rule) => rule.line === "http_access deny !allowlist");
  assert.notEqual(gate, -1, "an `http_access deny !allowlist` rule exists");
  rules.forEach((rule, index) => {
    if (rule.names.some(resolving)) {
      assert.ok(
        index > gate,
        `\`${rule.line}\` resolves the name and must follow the allowlist gate`
      );
    }
  });
  rules.slice(0, gate).forEach((rule) => {
    assert.equal(rule.action, "deny", `\`${rule.line}\` must not allow before the allowlist gate`);
  });
});

test("the proxy's resolvers are the ones its NetworkPolicy lets it reach", () => {
  const resolvers = lines
    .filter((line) => line.startsWith("dns_nameservers "))
    .flatMap((line) => line.split(/\s+/).slice(1));
  assert.ok(resolvers.length > 0, "squid.conf names its resolvers (dns_nameservers)");
  const policy = readFileSync(
    new URL("../deploy/kubernetes/sandboxes/network-policies.yaml", import.meta.url),
    "utf8"
  );
  // The only /32 ipBlocks in the sandbox policies are the proxy's resolvers.
  const allowed = [...policy.matchAll(/cidr:\s*(\S+)\/32\b/g)].map((m) => m[1]);
  assert.deepEqual(new Set(allowed), new Set(resolvers));
});

test("private destinations are still denied after resolution", () => {
  const names = rules.filter((rule) => rule.action === "deny").flatMap((rule) => rule.names);
  for (const name of ["to_localhost", "to_linklocal", "blocked_dst"]) {
    assert.ok(names.includes(name), `${name} is denied`);
  }
  assert.equal(rules.at(-1).line, "http_access deny all");
});
