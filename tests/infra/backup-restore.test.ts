import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gustavo-backup-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function runPowerShell(
  script: string,
  args: string[] = [],
  environment: Readonly<Record<string, string | undefined>> = {},
) {
  return execFileAsync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
    { cwd: process.cwd(), timeout: 30_000, windowsHide: true, env: { ...process.env, ...environment } },
  );
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("encrypted backup and isolated restore", () => {
  it("provides portable create, shared verification, and isolated restore commands", async () => {
    const paths = ["infra/backup/create.ps1", "infra/backup/verify.ps1", "infra/backup/restore-drill.ps1"];
    const [create, verify, restore] = await Promise.all(paths.map((path) => readFile(path, "utf8")));

    for (const source of [create, verify, restore]) {
      expect(source.length).toBeGreaterThan(100);
      expect(source).toMatch(/checksum|manifest/i);
      expect(source).not.toMatch(/Invoke-Expression|Start-Process/);
    }
    expect(create).toMatch(/encrypt/i);
    expect(create).toMatch(/Move-Item|\[System\.IO\.File\]::Move/);
    expect(create).toMatch(/S3|object storage/i);
    expect(create).toMatch(/--if-none-match/);
    expect(create).toMatch(/generationId/);
    expect(create).toMatch(/pg_export_snapshot/);
    expect(create).toMatch(/PGPASSFILE/);
    expect(create).not.toMatch(/\[string\]\$DatabaseUrl/);
    expect(create).not.toMatch(/--dbname=\$DatabaseUrl/);
    expect(verify).toMatch(/HMACSHA256/);
    expect(verify).toMatch(/New-OwnerOnlyDirectory/);
    expect(verify).toMatch(/New-OwnerOnlyFile/);
    expect(verify.indexOf("SetAccessRuleProtection")).toBeLessThan(verify.indexOf("$stream.Write"));
    expect(verify.indexOf("[IO.FileMode]::CreateNew")).toBeLessThan(verify.indexOf("$stream.Write"));
    expect(restore).toMatch(/ActiveDatabaseName/);
    expect(restore).toMatch(/verify\.ps1/);
    expect(restore).toMatch(/PGPASSFILE/);
    expect(restore).not.toMatch(/\[string\]\$MaintenanceDatabaseUrl/);
    expect(restore).not.toMatch(/--(?:dbname|maintenance-db)=\$\w*Url/);
    expect(create).toMatch(/ReadToEndAsync/);
    expect(create).toMatch(/SnapshotTimeoutSeconds/);
  }, 30_000);

  it("derives schema and event high-water from the exported pg_dump snapshot without credentials in argv", async () => {
    const directory = await temporaryDirectory();
    const toolsDirectory = join(directory, "tools");
    const audit = join(directory, "argv-audit.txt");
    const key = join(directory, "key.bin");
    const backupDirectory = join(directory, "database-backup");
    await mkdir(toolsDirectory);
    await writeFile(key, Buffer.alloc(64, 9));
    const psql = join(toolsDirectory, "psql.cmd");
    const pgDump = join(toolsDirectory, "pg_dump.cmd");
    await writeFile(psql, [
      "@echo off",
      `>>"${audit}" echo psql:%*`,
      `>>"${audit}" echo psql-pgpass:%PGPASSFILE%`,
      `>>"${audit}" echo psql-url:%GUSTAVO_BACKUP_DATABASE_URL%`,
      `powershell -NoProfile -Command "$target=Split-Path -Parent (Split-Path -Parent $env:PGPASSFILE); (Get-Acl -LiteralPath $target).AreAccessRulesProtected" >>"${audit}"`,
      "echo 00000003-1",
      "echo 0019_zz_stream.sql",
      "echo 987654",
      "more >nul",
    ].join("\r\n"));
    await writeFile(pgDump, [
      "@echo off",
      "setlocal EnableDelayedExpansion",
      `>>"${audit}" echo pg_dump:%*`,
      `>>"${audit}" echo pg_dump-pgpass:%PGPASSFILE%`,
      `>>"${audit}" echo pg_dump-url:%GUSTAVO_BACKUP_DATABASE_URL%`,
      "for %%D in (\"%PGPASSFILE%\") do >\"%%~dpD..\\database.payload.tmp\" echo snapshot-bound-dump",
      "exit /b 0",
    ].join("\r\n"));

    const databaseCreateArguments = [
      "-DestinationDirectory", backupDirectory,
      "-KeyFile", key,
      "-KeyVersion", "database-k1",
      "-PsqlPath", psql,
      "-PgDumpPath", pgDump,
      "-ExpectedSchemaVersion", "0019_zz_stream.sql",
      "-ExpectedEventHighWater", "987654",
    ];
    try {
      await runPowerShell("infra/backup/create.ps1", databaseCreateArguments, {
        GUSTAVO_BACKUP_DATABASE_URL: "postgresql://backup_user:env-secret@localhost:5432/gustavo",
      });
    }
    catch (error) {
      throw new Error(`Fake database protocol failed. Audit:\n${await readFile(audit, "utf8")}`, { cause: error });
    }

    const manifest = JSON.parse(await readFile(join(backupDirectory, "backup.manifest.json"), "utf8")) as {
      schemaVersion: string; eventHighWater: string;
    };
    expect(manifest).toMatchObject({ schemaVersion: "0019_zz_stream.sql", eventHighWater: "987654" });
    const auditText = await readFile(audit, "utf8");
    expect(auditText).toContain("--snapshot=00000003-1");
    expect(auditText).not.toContain("env-secret");
    expect(auditText).not.toContain("postgresql://");
    expect(auditText).toMatch(/psql-url:\s*(?:\r?\n)/);
    expect(auditText).toMatch(/pg_dump-url:\s*(?:\r?\n)/);
    expect(auditText).toMatch(/\r?\nTrue\r?\n/);
    const pgPassPaths = [...auditText.matchAll(/-pgpass:(.+)/g)].map((match) => match[1]!.trim());
    expect(pgPassPaths.length).toBe(2);
    for (const path of pgPassPaths) {
      await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }

    await expect(runPowerShell("infra/backup/create.ps1", [
      "-DestinationDirectory", join(directory, "mismatch-backup"),
      "-KeyFile", key,
      "-KeyVersion", "database-k1",
      "-PsqlPath", psql,
      "-PgDumpPath", pgDump,
      "-ExpectedEventHighWater", "987655",
    ], { GUSTAVO_BACKUP_DATABASE_URL: "postgresql://backup_user:env-secret@localhost:5432/gustavo" })).rejects.toMatchObject({ code: 1 });

    await expect(runPowerShell("infra/backup/create.ps1", [
      "-DatabaseUrl", "postgresql://backup_user:argv-secret@localhost:5432/gustavo",
      "-DestinationDirectory", join(directory, "argv-backup"),
      "-KeyFile", key,
      "-KeyVersion", "database-k1",
    ])).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/DatabaseUrl/) });
  }, 30_000);

  it("publishes immutable generation objects and never a mutable latest pointer", async () => {
    const directory = await temporaryDirectory();
    const fixture = join(directory, "fixture.json");
    const key = join(directory, "key.bin");
    const aws = join(directory, "aws.cmd");
    const audit = join(directory, "s3-audit.txt");
    await writeFile(fixture, JSON.stringify({ schemaVersion: "42", eventHighWater: "event-9" }));
    await writeFile(key, Buffer.alloc(64, 6));
    await writeFile(aws, [
      "@echo off",
      `>>"${audit}" echo %*`,
      "echo %* | findstr /C:\"backup.manifest.json\" >nul",
      "if not errorlevel 1 if \"%FAKE_S3_FAIL_MANIFEST%\"==\"1\" exit /b 9",
      "exit /b 0",
    ].join("\r\n"));
    const args = (destination: string) => [
      "-FixturePayloadPath", fixture,
      "-DestinationDirectory", destination,
      "-KeyFile", key,
      "-SchemaVersion", "42",
      "-EventHighWater", "event-9",
      "-KeyVersion", "fixture-k1",
      "-S3Uri", "s3://gustavo-backups/prod",
      "-AwsCliPath", aws,
    ];
    await runPowerShell("infra/backup/create.ps1", args(join(directory, "first")));
    await expect(runPowerShell("infra/backup/create.ps1", args(join(directory, "second")), {
      FAKE_S3_FAIL_MANIFEST: "1",
    })).rejects.toMatchObject({ code: 1 });

    const lines = (await readFile(audit, "utf8")).trim().split(/\r?\n/);
    expect(lines).toHaveLength(4);
    expect(lines.every((line) => line.includes("s3api put-object") && line.includes("--if-none-match=*"))).toBe(true);
    expect(lines.some((line) => /latest|current/i.test(line))).toBe(false);
    const objectKeys = lines.map((line) => /--key=([^ ]+)/.exec(line)?.[1]);
    expect(objectKeys.every(Boolean)).toBe(true);
    const generations = objectKeys.map((objectKey) => objectKey!.split("/")[1]);
    expect(generations[0]).toBe(generations[1]);
    expect(generations[2]).toBe(generations[3]);
    expect(generations[2]).not.toBe(generations[0]);
    expect(objectKeys.slice(0, 2).every((objectKey) => !objectKeys.slice(2).includes(objectKey))).toBe(true);
  }, 30_000);

  it("bounds and cleans a stalled snapshot session while draining stderr", async () => {
    const directory = await temporaryDirectory();
    const toolsDirectory = join(directory, "stall-tools");
    const key = join(directory, "key.bin");
    await mkdir(toolsDirectory);
    await writeFile(key, Buffer.alloc(64, 3));
    const psql = join(toolsDirectory, "psql.cmd");
    const pgDump = join(toolsDirectory, "pg_dump.cmd");
    await writeFile(psql, [
      "@echo off",
      "for /L %%I in (1,1,5000) do echo stderr-fill-%%I 1>&2",
      ":stall",
      "goto stall",
    ].join("\r\n"));
    await writeFile(pgDump, "@exit /b 99\r\n");
    const destination = join(directory, "stalled-backup");
    const startedAt = Date.now();
    await expect(runPowerShell("infra/backup/create.ps1", [
      "-DestinationDirectory", destination,
      "-KeyFile", key,
      "-KeyVersion", "database-k1",
      "-PsqlPath", psql,
      "-PgDumpPath", pgDump,
      "-SnapshotTimeoutSeconds", "1",
    ], { GUSTAVO_BACKUP_DATABASE_URL: "postgresql://backup_user:env-secret@localhost:5432/gustavo" })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/snapshot.*timed out/i),
    });
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(await readdir(directory)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^\.gustavo-backup-/)]));
  }, 30_000);

  it("round-trips a deterministic fixture without Docker or a network", async () => {
    const { stdout, stderr } = await runPowerShell("infra/backup/restore-drill.ps1", ["-UseFixture"]);
    expect(stderr).toBe("");
    expect(stdout).toContain("RESTORE DRILL PASSED");
    expect(stdout).toContain("event high-water: fixture-event-0002");
    expect(stdout).not.toMatch(/password|secret|key material/i);
  }, 30_000);

  it("rejects corruption, truncation, a wrong key, and manifest tampering", async () => {
    const directory = await temporaryDirectory();
    const fixture = join(directory, "fixture.json");
    const key = join(directory, "key.bin");
    const backupDirectory = join(directory, "backup");
    await writeFile(fixture, JSON.stringify({ schemaVersion: "42", eventHighWater: "event-9", rows: ["safe"] }));
    await writeFile(key, Buffer.alloc(64, 7));

    await runPowerShell("infra/backup/create.ps1", [
      "-FixturePayloadPath", fixture,
      "-DestinationDirectory", backupDirectory,
      "-KeyFile", key,
      "-SchemaVersion", "42",
      "-EventHighWater", "event-9",
      "-KeyVersion", "fixture-k1",
    ]);

    const manifestPath = join(backupDirectory, "backup.manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { artifact: string; schemaVersion: string };
    const artifactPath = join(backupDirectory, manifest.artifact);
    const verified = await runPowerShell("infra/backup/verify.ps1", ["-ManifestPath", manifestPath, "-KeyFile", key]);
    expect(verified.stdout).not.toContain("safe");
    expect(await readFile(manifestPath, "utf8")).not.toContain('"rows"');

    const originalArtifact = await readFile(artifactPath);
    expect(originalArtifact.includes(Buffer.from("safe"))).toBe(false);
    expect(originalArtifact.includes(Buffer.alloc(16, 7))).toBe(false);
    const wrongKey = join(directory, "wrong-key.bin");
    await writeFile(wrongKey, Buffer.alloc(64, 8));
    await expect(runPowerShell("infra/backup/verify.ps1", ["-ManifestPath", manifestPath, "-KeyFile", wrongKey])).rejects.toMatchObject({ code: 1 });

    await writeFile(artifactPath, originalArtifact.subarray(0, originalArtifact.length - 1));
    await expect(runPowerShell("infra/backup/verify.ps1", ["-ManifestPath", manifestPath, "-KeyFile", key])).rejects.toMatchObject({ code: 1 });

    const corrupted = Buffer.from(originalArtifact);
    corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;
    await writeFile(artifactPath, corrupted);
    await expect(runPowerShell("infra/backup/verify.ps1", ["-ManifestPath", manifestPath, "-KeyFile", key])).rejects.toMatchObject({ code: 1 });

    await writeFile(artifactPath, originalArtifact);
    await writeFile(manifestPath, JSON.stringify({ ...manifest, schemaVersion: "43" }));
    await expect(runPowerShell("infra/backup/verify.ps1", ["-ManifestPath", manifestPath, "-KeyFile", key])).rejects.toMatchObject({ code: 1 });

    await writeFile(manifestPath, JSON.stringify({ ...manifest, eventHighWater: "event-10" }));
    await expect(runPowerShell("infra/backup/verify.ps1", ["-ManifestPath", manifestPath, "-KeyFile", key])).rejects.toMatchObject({ code: 1 });

    await writeFile(manifestPath, JSON.stringify({ ...manifest, payloadSha256: "0".repeat(64) }));
    await expect(runPowerShell("infra/backup/verify.ps1", ["-ManifestPath", manifestPath, "-KeyFile", key])).rejects.toMatchObject({ code: 1 });

    await writeFile(manifestPath, JSON.stringify({ ...manifest, retention: {
      dailyRetentionDays: "0", weeklyRetentionWeeks: "8", monthlyRetentionMonths: "12",
    } }));
    await expect(runPowerShell("infra/backup/verify.ps1", ["-ManifestPath", manifestPath, "-KeyFile", key])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/retention[\s\S]*outside supported bounds/i),
    });
  }, 30_000);

  it("refuses unsafe artifact paths, active database names, and overwrite attempts", async () => {
    const directory = await temporaryDirectory();
    const fixture = join(directory, "fixture.json");
    const key = join(directory, "key.bin");
    const backupDirectory = join(directory, "backup");
    await writeFile(fixture, JSON.stringify({ schemaVersion: "42", eventHighWater: "event-9" }));
    await writeFile(key, Buffer.alloc(64, 7));
    const createArgs = [
      "-FixturePayloadPath", fixture,
      "-DestinationDirectory", backupDirectory,
      "-KeyFile", key,
      "-SchemaVersion", "42",
      "-EventHighWater", "event-9",
      "-KeyVersion", "fixture-k1",
    ];
    await runPowerShell("infra/backup/create.ps1", createArgs);
    await expect(runPowerShell("infra/backup/create.ps1", createArgs)).rejects.toMatchObject({ code: 1 });
    await expect(runPowerShell("infra/backup/create.ps1", [...createArgs, "-DailyRetentionDays", "0"])).rejects.toMatchObject({ code: 1 });

    const manifestPath = join(backupDirectory, "backup.manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(manifestPath, JSON.stringify({ ...manifest, artifact: "../outside.gbackup" }));
    await expect(runPowerShell("infra/backup/verify.ps1", ["-ManifestPath", manifestPath, "-KeyFile", key])).rejects.toMatchObject({ code: 1 });

    await expect(runPowerShell("infra/backup/restore-drill.ps1", [
      "-ManifestPath", manifestPath,
      "-KeyFile", key,
      "-RestoreDatabaseName", "gustavo",
      "-ActiveDatabaseName", "GUSTAVO",
    ])).rejects.toMatchObject({ code: 1 });
  }, 30_000);
});
