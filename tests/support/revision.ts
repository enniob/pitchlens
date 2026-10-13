import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Fingerprints dirty and untracked implementation/test files without including credentials. */
export function evaluationRevision(): string {
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "src", "tests", "tests-live", "package.json", "package-lock.json", "tsconfig.json", "next.config.*", "vitest*.mts"], { encoding: "utf8" })
    .split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update("\0").update(readFileSync(file)).update("\0");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return `${head}; implementation/test SHA-256 ${hash.digest("hex")}`;
}
