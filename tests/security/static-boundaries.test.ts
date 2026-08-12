import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, extname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import CanonicalHome from "../../app/page";
import { createPublicFeedHandler } from "../../app/api/public/feed/route";
import { projectFeedEvent } from "../../lib/server/dal/feed";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const POWERSHELL_EXECUTABLE = process.platform === "win32" ? "powershell" : "pwsh";
const TEXT_EXTENSIONS = new Set([
  ".cjs", ".env", ".js", ".json", ".mjs", ".ps1", ".sql", ".ts", ".tsx", ".yaml", ".yml",
]);

const ACTIVE_SCAN_ROOTS = [
  "app",
  "components",
  "db/migrations",
  "lib",
  "scripts",
  "worker",
  "infra/compose.yaml",
  "infra/env.example",
  "instrumentation.ts",
  "next.config.ts",
  "package.json",
  "policy/editorial-policy.json",
] as const;

const ACTIVE_SCAN_EXACT_EXCLUSIONS = new Set([
  "scripts/validate.ps1",
]);

// These files preserve migration evidence. They are not active product configuration,
// and adding another exception requires a security review of this exact list.
const AUDIT_ONLY_PATH_ALLOWLIST = new Set([
  "docs/API_CONTRACTS.md",
  "docs/DECISION_HISTORY.md",
  "docs/ETH_CONTEXT.md",
  "docs/EXPORTS_AND_SYMBOLS.md",
  "docs/GRADING_AND_RISK.md",
  "docs/MECHANISM.md",
  "policy/lab-policy.json",
  "state/current-profile.json",
  "state/latest-market-context.json",
]);

const TEST_SUPPORT_PATH_ALLOWLIST = new Set([
  "lib/server/models/fake.ts",
]);

const FAKE_PROVIDER_GUARD_ALLOWLIST = {
  path: "lib/server/models/gateway.ts",
  occurrence: 'production && config.providerId === "fake"',
} as const;

const FAKE_PROVIDER_TEST_PATH_ALLOWLIST = new Set([
  "tests/models/gateway-audit.test.ts",
]);

const DEBUG_PATH_ALLOWLIST = new Set<string>();

const MIGRATION_EVIDENCE_ALLOWLIST = [
  { path: "db/migrations/0002_identity.sql", pattern: "password_credentials" },
  { path: "db/migrations/0010_challenge_ledger.sql", pattern: "EXCHANGE_FEE" },
  { path: "db/migrations/0019_privacy_controls.sql", pattern: "position|execution" },
] as const;

const FORBIDDEN_SOURCE_CHECKS: ReadonlyArray<readonly [string, RegExp]> = [
  ["real-order function", /\b(?:place|submit|execute|route|send|export)(?:Real|Live|External)(?:Order|Trade)s?\b/i],
  ["execution connector import", /\b(?:from|require\s*\()\s*["'][^"']*(?:alpaca|ibkr|interactive-brokers|binance|coinbase-pro|broker|exchange|execution)[^"']*["']/i],
  ["broker/exchange endpoint", /https?:\/\/[^\s"']*(?:api\.)?(?:alpaca\.markets|interactivebrokers\.com|binance\.com|coinbase\.com)\b/i],
  ["external execution command", /\b(?:curl|wget|Invoke-RestMethod|Invoke-WebRequest)\b[^\r\n]*(?:broker|exchange|orders?|trades?|execution)/i],
  ["public secret", /\bNEXT_PUBLIC_[A-Z0-9_]*(?:API_?)?(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)S?\b/],
  ["copy-trade language", /\b(?:copy[ -]?trade|buy now|sell now|execute this trade)\b/i],
  ["guaranteed outcome", /\b(?:guaranteed?|promise[sd]?)\s+(?:profit|returns?|accuracy|performance)\b/i],
  ["sentience claim", /\b(?:is|am|are|becomes?)\s+(?:truly\s+)?(?:sentient|conscious|self-aware)\b/i],
  ["perfect-memory claim", /\b(?:(?:can|does|will|Gustavo)\s+(?:perfect(?:ly)?|always)\s+(?:recall|remember)(?:s|ed|ing)?|(?:has|offers?)\s+perfect recall)\b/i],
];

const SECRET_SHAPE_CHECKS: ReadonlyArray<readonly [string, RegExp]> = [
  ["OpenAI-style key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["assigned secret", /\b(?:API_?KEY|SECRET|TOKEN|PASSWORD|CREDENTIALS?)\s*[:=]\s*["']?[A-Za-z0-9+/_=-]{20,}["']?/i],
];

const PUBLIC_SECRET_NAME = /\b(?:NEXT_PUBLIC_[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)S?|GUSTAVO_[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)S?|DATABASE_URL|VALKEY_URL|POSTGRES_PASSWORD)\b/;
const MODULE_SPECIFIER_PATTERN = /\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["']([^"'\r\n]+)["']/gi;

interface SourceFile {
  readonly path: string;
  readonly source: string;
}

async function collectFiles(entry: string): Promise<string[]> {
  const absolute = resolve(REPOSITORY_ROOT, entry);
  const info = await stat(absolute);
  if (info.isFile()) return [absolute];

  const entries = await readdir(absolute, { withFileTypes: true });
  const nested = await Promise.all(entries
    .filter((item) => !item.isSymbolicLink())
    .map((item) => collectFiles(join(entry, item.name))));
  return nested.flat();
}

async function activeSources(): Promise<SourceFile[]> {
  const files = (await Promise.all(ACTIVE_SCAN_ROOTS.map(collectFiles)))
    .flat()
    .filter((file) => TEXT_EXTENSIONS.has(extname(file)))
    .filter((file) => !ACTIVE_SCAN_EXACT_EXCLUSIONS.has(
      relative(REPOSITORY_ROOT, file).replaceAll("\\", "/"),
    ));
  return Promise.all(files.map(async (file) => ({
    path: relative(REPOSITORY_ROOT, file).replaceAll("\\", "/"),
    source: await readFile(file, "utf8"),
  })));
}

function matchingPaths(files: readonly SourceFile[], pattern: RegExp): string[] {
  return files.filter(({ source }) => pattern.test(source)).map(({ path }) => path);
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  return [...counts.values()].reduce((entropy, count) => {
    const probability = count / value.length;
    return entropy - probability * Math.log2(probability);
  }, 0);
}

function hasHighEntropyLiteral(source: string): boolean {
  return [...source.matchAll(/["']([A-Za-z0-9+/_=-]{32,})["']/g)]
    .map((match) => match[1]!)
    .some((value) => /[a-z]/.test(value)
      && /[A-Z]/.test(value)
      && /\d/.test(value)
      && shannonEntropy(value) >= 4.3);
}

function stripJavaScriptCommentsPreservingStrings(source: string): string {
  let result = "";
  let state: "code" | "single" | "double" | "template" | "line" | "block" = "code";
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]!;
    const next = source[index + 1];
    if (state === "line") {
      if (current === "\n" || current === "\r") {
        state = "code";
        result += current;
      } else result += " ";
      continue;
    }
    if (state === "block") {
      if (current === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else result += current === "\n" || current === "\r" ? current : " ";
      continue;
    }
    if (state === "code") {
      if (current === "/" && next === "/") {
        result += "  ";
        index += 1;
        state = "line";
      } else if (current === "/" && next === "*") {
        result += "  ";
        index += 1;
        state = "block";
      } else {
        result += current;
        if (current === "'") state = "single";
        else if (current === '"') state = "double";
        else if (current === "`") state = "template";
      }
      continue;
    }
    result += current;
    if (current === "\\" && next !== undefined) {
      result += next;
      index += 1;
    } else if ((state === "single" && current === "'")
      || (state === "double" && current === '"')
      || (state === "template" && current === "`")) state = "code";
  }
  return result;
}

function normalModuleTarget(sourcePath: string, specifier: string): string {
  const withoutSuffix = specifier.replace(/[?#].*$/u, "").replaceAll("\\", "/");
  const withoutExtension = withoutSuffix.replace(/\.[cm]?[jt]sx?$/iu, "");
  const withoutIndex = withoutExtension.replace(/\/index$/iu, "");
  if (withoutIndex.startsWith(".")) {
    return posix.normalize(posix.join(posix.dirname(sourcePath), withoutIndex));
  }
  return withoutIndex;
}

function importsFakeProvider(path: string, source: string): boolean {
  const uncommented = stripJavaScriptCommentsPreservingStrings(source);
  return [...uncommented.matchAll(MODULE_SPECIFIER_PATTERN)].some((match) => {
    const target = normalModuleTarget(path, match[1]!);
    return target === "lib/server/models/fake"
      || (!target.startsWith(".") && /(?:^|\/)models\/fake$/iu.test(target));
  });
}

function pathWithinPrefix(root: string, candidate: string, caseSensitive: boolean): boolean {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const comparablePrefix = caseSensitive ? prefix : prefix.toLowerCase();
  const comparableCandidate = caseSensitive ? candidate : candidate.toLowerCase();
  return comparableCandidate.startsWith(comparablePrefix);
}

function runPowerShell(arguments_: readonly string[]) {
  const result = spawnSync(POWERSHELL_EXECUTABLE, [...arguments_], {
    cwd: dirname(REPOSITORY_ROOT),
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`Required ${POWERSHELL_EXECUTABLE} executable unavailable: ${result.error.message}`);
  }
  return result;
}

describe("Gustavo MVP static safety boundary", () => {
  it("uses platform-aware repository containment and PowerShell selection", () => {
    expect(pathWithinPrefix("/workspace/Gustavo", "/workspace/Gustavo/app/page.tsx", true))
      .toBe(true);
    expect(pathWithinPrefix("/workspace/Gustavo", "/workspace/gustavo/app/page.tsx", true))
      .toBe(false);
    expect(pathWithinPrefix("C:/Workspace/Gustavo", "c:/workspace/gustavo/app/page.tsx", false))
      .toBe(true);
    expect(pathWithinPrefix("/workspace/Gustavo", "/workspace/Gustavo-sibling/file.ts", true))
      .toBe(false);
    expect(POWERSHELL_EXECUTABLE).toBe(process.platform === "win32" ? "powershell" : "pwsh");
    const probe = runPowerShell(["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"]);
    expect(probe.status).toBe(0);
  });

  it("uses an exact, narrow audit-only allowlist", () => {
    expect([...AUDIT_ONLY_PATH_ALLOWLIST]).toEqual([
      "docs/API_CONTRACTS.md",
      "docs/DECISION_HISTORY.md",
      "docs/ETH_CONTEXT.md",
      "docs/EXPORTS_AND_SYMBOLS.md",
      "docs/GRADING_AND_RISK.md",
      "docs/MECHANISM.md",
      "policy/lab-policy.json",
      "state/current-profile.json",
      "state/latest-market-context.json",
    ]);
    expect([...AUDIT_ONLY_PATH_ALLOWLIST].some((path) =>
      /(^|\/)(app|components|lib|worker)(\/|$)/.test(path))).toBe(false);
    expect([...AUDIT_ONLY_PATH_ALLOWLIST].some((path) =>
      /(^|\/)(tests?|fixtures?|debug)(\/|$)/i.test(path))).toBe(false);
    expect([...TEST_SUPPORT_PATH_ALLOWLIST]).toEqual(["lib/server/models/fake.ts"]);
    expect([...TEST_SUPPORT_PATH_ALLOWLIST].some((path) =>
      /(^|\/)(app|components|worker|tests?|fixtures?|debug)(\/|$)/i.test(path))).toBe(false);
    expect(FAKE_PROVIDER_GUARD_ALLOWLIST).toEqual({
      path: "lib/server/models/gateway.ts",
      occurrence: 'production && config.providerId === "fake"',
    });
    expect([...FAKE_PROVIDER_TEST_PATH_ALLOWLIST]).toEqual([
      "tests/models/gateway-audit.test.ts",
    ]);
    expect([...DEBUG_PATH_ALLOWLIST]).toEqual([]);
    expect([...ACTIVE_SCAN_EXACT_EXCLUSIONS]).toEqual(["scripts/validate.ps1"]);
    expect(MIGRATION_EVIDENCE_ALLOWLIST).toEqual([
      { path: "db/migrations/0002_identity.sql", pattern: "password_credentials" },
      { path: "db/migrations/0010_challenge_ledger.sql", pattern: "EXCHANGE_FEE" },
      { path: "db/migrations/0019_privacy_controls.sql", pattern: "position|execution" },
    ]);
  });

  it("contains no real execution connectivity, public secret names, or unsafe claims", async () => {
    const files = await activeSources();
    for (const [label, pattern] of FORBIDDEN_SOURCE_CHECKS) {
      expect(matchingPaths(files, pattern), label).toEqual([]);
    }

    const routePaths = files
      .map(({ path }) => path)
      .filter((path) => /^app\/api\//.test(path));
    expect(routePaths.filter((path) =>
      /\/(?:broker|exchange|execution|real-orders?|live-orders?|credentials?|test|debug|fixtures?|seed)(?:\/|\.)/i.test(path),
    )).toEqual([]);

    const nonFakeSources = files.filter(({ path }) => !TEST_SUPPORT_PATH_ALLOWLIST.has(path));
    expect(nonFakeSources.filter(({ path, source }) => importsFakeProvider(path, source))
      .map(({ path }) => path)).toEqual([]);
    expect(matchingPaths(nonFakeSources, /\bfakeModelProvider\b/)).toEqual([]);
    const nonFakeAuthority = nonFakeSources.filter(({ path }) =>
      path !== FAKE_PROVIDER_GUARD_ALLOWLIST.path);
    expect(matchingPaths(nonFakeAuthority, /providerId\s*:\s*["']fake["']/i)).toEqual([]);
    const gateway = files.find(({ path }) => path === FAKE_PROVIDER_GUARD_ALLOWLIST.path)?.source ?? "";
    expect(gateway.match(/providerId\s*===\s*["']fake["']/g)).toEqual([
      'providerId === "fake"',
    ]);
    expect(gateway).toContain(FAKE_PROVIDER_GUARD_ALLOWLIST.occurrence);
    const approvedFakeTest = await readFile(
      resolve(REPOSITORY_ROOT, [...FAKE_PROVIDER_TEST_PATH_ALLOWLIST][0]!), "utf8",
    );
    expect(approvedFakeTest).toContain('from "../../lib/server/models/fake"');
    expect(files.find(({ path }) => path === "infra/compose.yaml")?.source)
      .toMatch(/GUSTAVO_TEST_FIXTURES_ENABLED:\s*["']?false["']?/);
    expect(files.find(({ path }) => path === "instrumentation.ts")?.source)
      .toMatch(/assertProductionFixturesDisabled[\s\S]*PRODUCTION_TEST_FIXTURES_FORBIDDEN/);

    for (const evidence of MIGRATION_EVIDENCE_ALLOWLIST) {
      expect(files.find(({ path }) => path === evidence.path)?.source).toContain(evidence.pattern);
    }
  });

  it("detects adversarial execution, secret, and claim examples without widening safe exceptions", () => {
    const malicious = [
      "placeRealOrder(request)",
      'import client from "@vendor/alpaca"',
      "https://api.binance.com/api/v3/order",
      "curl https://broker.example/orders",
      "NEXT_PUBLIC_MODEL_API_KEY",
      "buy now for guaranteed profit",
      "Gustavo is sentient and does always remember",
    ];
    for (const source of malicious) {
      expect(FORBIDDEN_SOURCE_CHECKS.some(([, pattern]) => pattern.test(source)), source).toBe(true);
    }

    const safe = [
      "placePaperOrder(request)",
      "app/api/account/export/route.ts",
      'credentials: "same-origin"',
      "Gustavo is not sentient and does not perfectly recall conversations",
      "SIMULATION ONLY — NOT A REAL TRADE",
    ];
    for (const source of safe) {
      expect(FORBIDDEN_SOURCE_CHECKS.some(([, pattern]) => pattern.test(source)), source).toBe(false);
    }

    expect(/\/(?:broker|exchange|execution|real-orders?|live-orders?|credentials?|test|debug|fixtures?|seed)(?:\/|\.)/i
      .test("/api/broker/export/route.ts")).toBe(true);
    expect(/\/(?:broker|exchange|execution|real-orders?|live-orders?|credentials?|test|debug|fixtures?|seed)(?:\/|\.)/i
      .test("/api/account/export/route.ts")).toBe(false);
  });

  it("contains no committed secret-shaped values and never reports their values", async () => {
    const files = await activeSources();
    for (const [label, pattern] of SECRET_SHAPE_CHECKS) {
      const paths = matchingPaths(files, pattern);
      expect(paths, `${label}; findings intentionally report paths only`).toEqual([]);
    }
    expect(files.filter(({ source }) => hasHighEntropyLiteral(source)).map(({ path }) => path),
      "high-entropy findings intentionally report paths only").toEqual([]);
    expect(hasHighEntropyLiteral('const value = "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cD0fG"')).toBe(true);
    expect(hasHighEntropyLiteral('const value = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"')).toBe(false);
  });

  it("keeps protected text, ciphertext, and key material out of public DTO, HTML, RSC, and API snapshots", async () => {
    const protectedText = "t31-private-thesis-never-public";
    const ciphertext = "t31-ciphertext-envelope-never-public";
    const keyMaterial = "t31-root-key-material-never-public";
    const publicDto = projectFeedEvent({ role: "PUBLIC" }, {
      id: "event-t31",
      accountId: "account-t31",
      type: "brain.response.completed",
      createdAt: "2026-08-12T12:00:00.000Z",
      topic: "AAPL",
      protectedText: `${protectedText}:${ciphertext}:${keyMaterial}`,
    });
    const taintedPublicProjection = [
      { ...publicDto, protectedText, ciphertext, keyMaterial },
    ];
    const response = await createPublicFeedHandler(async () => taintedPublicProjection)();
    const snapshots = [
      JSON.stringify(publicDto),
      renderToStaticMarkup(await CanonicalHome()),
      await response.text(),
    ];

    const buildIdMarker = await stat(resolve(REPOSITORY_ROOT, ".next/BUILD_ID"));
    const completionMarker = await stat(resolve(REPOSITORY_ROOT, ".next/export-marker.json"));
    const buildInputs = (await Promise.all([
      "app", "components", "lib", "next.config.ts", "package.json", "pnpm-lock.yaml",
    ].map(collectFiles))).flat();
    const latestInput = Math.max(...(await Promise.all(buildInputs.map(async (path) =>
      (await stat(path)).mtimeMs))));
    expect(buildIdMarker.size).toBeGreaterThan(0);
    expect(completionMarker.size).toBeGreaterThan(0);
    expect(completionMarker.mtimeMs).toBeGreaterThanOrEqual(latestInput);

    const builtPublicFiles = [
      ...(await collectFiles(".next/static")),
      ...(await collectFiles(".next/server/app/index.segments")),
      ...(await collectFiles(".next/server/app/page")),
      ...(await collectFiles(".next/server/app/api/public/feed/route")),
      ...[
        ".next/build-manifest.json",
        ".next/prerender-manifest.json",
        ".next/server/app/index.html",
        ".next/server/app/index.rsc",
        ".next/server/app/page.js",
        ".next/server/app/page.js.map",
        ".next/server/app/page_client-reference-manifest.js",
        ".next/server/app/api/public/feed/route.js",
        ".next/server/app/api/public/feed/route.js.map",
        ".next/server/app/api/public/feed/route_client-reference-manifest.js",
      ].map((path) => resolve(REPOSITORY_ROOT, path)),
    ];
    expect(builtPublicFiles.length).toBeGreaterThan(10);
    for (const path of builtPublicFiles) {
      snapshots.push(await readFile(path, "utf8"));
    }

    for (const snapshot of snapshots) {
      expect(snapshot).not.toContain(protectedText);
      expect(snapshot).not.toContain(ciphertext);
      expect(snapshot).not.toContain(keyMaterial);
      expect(snapshot).not.toMatch(PUBLIC_SECRET_NAME);
      expect(hasHighEntropyLiteral(snapshot)).toBe(false);
    }
    expect(JSON.parse(snapshots[2]!)).toEqual({ events: [publicDto] });
  });

  it("documents privacy controls, authorized imports, simulation limits, and launch review", async () => {
    const privacy = await readFile(resolve(REPOSITORY_ROOT, "docs/PRIVACY.md"), "utf8");
    const terms = await readFile(resolve(REPOSITORY_ROOT, "docs/TERMS.md"), "utf8");
    const data = await readFile(resolve(REPOSITORY_ROOT, "docs/DATA_POLICY.md"), "utf8");
    const security = await readFile(resolve(REPOSITORY_ROOT, "docs/SECURITY.md"), "utf8");

    expect(privacy).toMatch(/export and forgetting/i);
    expect(privacy).toMatch(/private (?:account|Node Brain).*(?:scope|conversation)/is);
    expect(privacy).toMatch(/proposal summar(?:y|ies).*(?:raw private|authorized)/is);
    expect(data).toMatch(/authorized external chat import/i);
    expect(data).toMatch(/model providers?.*(?:data|prompt|content)/is);
    expect(data).toMatch(/retention.*export.*forget/is);
    expect(terms).toContain("SIMULATION ONLY — NOT A REAL TRADE");
    expect(terms).toMatch(/educational market commentary.*not (?:individualized )?financial advice/is);
    expect(terms).toMatch(/delayed data.*(?:labeled|disclosed)/is);
    expect(terms).toMatch(/not (?:sentient|conscious).*perfect recall/is);
    expect(security).toMatch(/threat model/i);
    expect(security).toMatch(/key rotation/i);
    expect(security).toMatch(/incident response/i);
    expect(security).toMatch(/rate limits?.*backpressure/is);
    expect(security).toMatch(/CSRF.*exact Origin/is);
    expect(security).toMatch(/Sec-Fetch-Site.*cross-site/is);
    expect(security).toMatch(/__Host-gustavo-session.*HttpOnly.*Secure.*SameSite=Strict.*Path=\//is);
    expect(`${security}\n${terms}`).toMatch(/qualified legal review.*before public launch/is);
  });

  it("fails closed on an injected secret without echoing its value", async () => {
    const fixtureDirectory = resolve(REPOSITORY_ROOT, ".tmp-test/security-validator");
    const fixturePath = resolve(fixtureDirectory, "injected-secret.ts");
    const secretValue = "sk-T31RegressionOnlyNotARealSecret123456";
    await mkdir(fixtureDirectory, { recursive: true });
    await writeFile(fixturePath, `export const leaked = "${secretValue}";\n`, "utf8");
    try {
      const result = runPowerShell([
          "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
          resolve(REPOSITORY_ROOT, "scripts/validate.ps1"),
          "-AdditionalScanFixture", ".tmp-test/security-validator/injected-secret.ts",
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Safety violation (OpenAI-style secret)");
      expect(result.stderr).not.toContain(secretValue);
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it("fails closed on every fake-provider import spelling and duplicate fake authority", async () => {
    const fixtureDirectory = resolve(REPOSITORY_ROOT, ".tmp-test/security-validator");
    const fixtures = [
      ['import fake from "../../lib/server/models/fake.ts";\n', "static-ts.ts"],
      ['import fake from "../../lib/server/models/fake.js";\n', "static-js.ts"],
      ['import fake from "../../lib/server/models/fake/index";\n', "static-index.ts"],
      ['const fake = await import("../../lib/server/models/fake.ts?worker#x");\n', "dynamic-query.ts"],
      ['const fake = require("@alias/models/fake.js#bundle");\n', "require-alias.ts"],
      ['export { fakeModelProvider as provider } from "../../lib/server/models/fake";\n', "reexport.ts"],
      ['export * from "./fake";\n', "adjacent-reexport.ts"],
      ['import provider from "./fake.ts";\n', "adjacent-default.ts"],
      ['import * as provider from "./fake.js?worker#bundle";\n', "adjacent-namespace.ts"],
      ['export { default as provider } from "./fake/index.ts#alias";\n', "adjacent-index.ts"],
      ['export * from /* boundary */ "./fake";\n', "adjacent-block-comment.ts"],
      ['import /* binding */ provider from /* target */ "./fake.ts?x#y";\n', "adjacent-default-comment.ts"],
      ['import * as provider from // target\n "./fake.js#namespace";\n', "adjacent-line-comment.ts"],
      ['const provider = require(/* target */ "./fake/index.js?x");\n', "adjacent-require-comment.ts"],
      ['export const config = { providerId: "fake" };\n', "duplicate-authority.ts"],
    ] as const;
    await mkdir(fixtureDirectory, { recursive: true });
    try {
      for (const [source, name] of fixtures) {
        const fixturePath = resolve(fixtureDirectory, name);
        await writeFile(fixturePath, source, "utf8");
        const result = runPowerShell([
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
            resolve(REPOSITORY_ROOT, "scripts/validate.ps1"),
            "-AdditionalScanFixture", `.tmp-test/security-validator/${name}`,
            ...(name.startsWith("adjacent-")
              ? ["-AdditionalScanFixtureVirtualPath", `lib/server/models/${name}`]
              : []),
        ]);
        expect(result.status, name).toBe(1);
        expect(result.stderr, name).toMatch(/fake provider/i);
        await rm(fixturePath, { force: true });
      }
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
    expect(stripJavaScriptCommentsPreservingStrings(
      'const literal = "// keep /* this */"; import /* remove */ value from "./fake";',
    )).toBe('const literal = "// keep /* this */"; import              value from "./fake";');
  }, 120_000);

  it("treats instrumentation changes after a completed build as stale", async () => {
    const instrumentationPath = resolve(REPOSITORY_ROOT, "instrumentation.ts");
    const original = await stat(instrumentationPath);
    const completion = await stat(resolve(REPOSITORY_ROOT, ".next/export-marker.json"));
    const future = new Date(Math.max(Date.now(), completion.mtimeMs) + 2_000);
    try {
      await utimes(instrumentationPath, original.atime, future);
      const result = runPowerShell([
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
        resolve(REPOSITORY_ROOT, "scripts/validate.ps1"),
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Next build artifacts are stale");
    } finally {
      await utimes(instrumentationPath, original.atime, original.mtime);
    }
  }, 20_000);

  it("uses a fail-closed, repository-root-safe validator without dynamic command execution", async () => {
    const validatorPath = resolve(REPOSITORY_ROOT, "scripts/validate.ps1");
    const validator = await readFile(validatorPath, "utf8");

    expect(validator).toContain("$ErrorActionPreference = 'Stop'");
    expect(validator).toMatch(/\$PSScriptRoot/);
    expect(validator).toMatch(/GetFullPath/);
    expect(validator).toMatch(/AuditOnlyPathAllowlist/);
    expect(validator).toMatch(/TestSupportPathAllowlist/);
    expect(validator).toMatch(/FakeProviderGuardAllowlist/);
    expect(validator).toMatch(/FakeProviderTestPathAllowlist/);
    expect(validator).toMatch(/Assert-ExactFakeProviderGuard/);
    expect(validator).toMatch(/MigrationEvidenceAllowlist/);
    expect(validator).toMatch(/DebugPathAllowlist/);
    expect(validator).toMatch(/BuildFreshnessInputs/);
    expect(validator).toMatch(/\.next[\\/]BUILD_ID/);
    expect(validator).toMatch(/\.next[\\/]export-marker\.json/);
    expect(validator).toMatch(/\.next[\\/]static/);
    expect(validator).toMatch(/db[\\/]migrations/);
    expect(validator).toMatch(/["']scripts["']/);
    expect(validator).toMatch(/AdditionalScanFixture/);
    expect(validator).toMatch(/AdditionalScanFixtureVirtualPath/);
    expect(validator).toMatch(/Get-NormalModuleTarget/);
    expect(validator).toMatch(/Remove-JavaScriptCommentsPreservingStrings/);
    expect(validator).toMatch(/StringComparison.*Ordinal/);
    expect(validator).toMatch(/OSVersion\.Platform/);
    expect(validator).toMatch(/Get-ShannonEntropy/);
    expect(validator).toMatch(/NEXT_PUBLIC_/);
    expect(validator).toMatch(/BEGIN .*PRIVATE KEY/);
    expect(validator).toMatch(/browser secret name/);
    expect(validator).toMatch(/GUSTAVO_TEST_FIXTURES_ENABLED[\s\S]*false/);
    expect(validator).not.toMatch(/\b(?:Invoke-Expression|iex|Start-Process|cmd(?:\.exe)?\s+\/c)\b/i);
    expect(validator).not.toMatch(/(?:^|[\r\n])\s*(?:&|\.)\s*\$[A-Za-z]/);

    const result = runPowerShell([
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", validatorPath,
    ]);
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  }, 20_000);
});
