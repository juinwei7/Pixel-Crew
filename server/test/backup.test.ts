import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { deflateSync, gzipSync } from "node:zlib";
import * as tar from "tar";
import { AvatarStore } from "../src/avatarStore.js";
import { stageExportDirectory } from "../src/backupExport.js";
import { commitBackupRestore } from "../src/backupRestoreCommit.js";
import {
  BackupValidationError,
  extractAndValidateBackup,
  restoreFromSnapshot,
  snapshotCurrentData,
  swapInRestoredData,
} from "../src/backupImport.js";
import { LocalStore } from "../src/store.js";

function createResponseHarness(): {
  response: any;
  statusCode: () => number | undefined;
  body: () => unknown;
} {
  let currentStatus: number | undefined;
  let currentBody: unknown;
  const listeners = new Map<string, () => void>();
  const response = {
    status(code: number) { currentStatus = code; return response; },
    json(payload: unknown) {
      currentBody = payload;
      listeners.get("finish")?.();
      return response;
    },
    once(event: string, listener: () => void) {
      listeners.set(event, listener);
      return response;
    },
  };
  return { response, statusCode: () => currentStatus, body: () => currentBody };
}

function makePng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const scanlines = Buffer.alloc(height * (1 + width * 4));
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData), 0);
    return Buffer.concat([length, typeAndData, crc]);
  };
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function buildArchive(stagingDir: string, archivePath: string): Promise<void> {
  await tar.create(
    { gzip: true, cwd: stagingDir, file: archivePath, portable: true } as any,
    ["manifest.json", "db", "avatars", "mux"],
  );
}

test("full round trip: export a real DB+avatars+mux, validate the archive, then restore into a fresh location", async () => {
  const root = mkdtempSync(join(tmpdir(), "pixel-crew-backup-roundtrip-"));
  try {
    const dbPath = join(root, "cockpit.sqlite");
    const avatarDir = join(root, "avatars");
    const muxDbPath = join(root, "terminal-mux.sqlite");
    mkdirSync(avatarDir);

    const store = new LocalStore(dbPath);
    store.saveWorker({
      id: "w1", name: "一號機", model: null, colorIndex: 0, avatarId: null,
      avatarKind: "preset", avatarPresetId: "classic", provider: "claude",
      workspacePath: "/repo", sessionId: "s1", completedTurns: 3,
      persona: null, autoApproveMode: "off",
    });
    store.close();

    const avatarStore = new AvatarStore(avatarDir);
    const avatarId = await avatarStore.save(makePng(24, 32).toString("base64"));

    const { DatabaseSync } = await import("node:sqlite");
    const muxDb = new DatabaseSync(muxDbPath);
    muxDb.exec(`
      CREATE TABLE mux_terminal_tabs (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, launch_command TEXT, state TEXT NOT NULL, scrollback TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE mux_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    muxDb.prepare("INSERT INTO mux_terminal_tabs (id, cwd, launch_command, state, scrollback, created_at, updated_at) VALUES (?, ?, NULL, 'running', '', 'now', 'now')").run("terminal-1", "/repo");
    muxDb.close();

    const stagingDir = join(root, "staging");
    stageExportDirectory({ dbPath, avatarDir, muxDbPath }, stagingDir);
    const archivePath = join(root, "backup.tar.gz");
    await buildArchive(stagingDir, archivePath);

    const validateDir = join(root, "validate");
    const summary = await extractAndValidateBackup(archivePath, validateDir);
    assert.equal(summary.workerCount, 1);
    assert.equal(summary.avatarCount, 1);
    assert.deepEqual(summary.warnings, []);

    const restoredDbPath = join(root, "restored", "cockpit.sqlite");
    const restoredAvatarDir = join(root, "restored", "avatars");
    const restoredMuxDbPath = join(root, "restored", "terminal-mux.sqlite");
    mkdirSync(join(root, "restored"));
    const snapshotDir = join(root, "pre-restore");
    snapshotCurrentData({ dbPath: restoredDbPath, avatarDir: restoredAvatarDir, muxDbPath: restoredMuxDbPath }, snapshotDir);
    swapInRestoredData({ dbPath: restoredDbPath, avatarDir: restoredAvatarDir, muxDbPath: restoredMuxDbPath }, validateDir);

    const restored = new LocalStore(restoredDbPath);
    try {
      const [worker] = restored.loadWorkers(10);
      assert.equal(worker?.name, "一號機");
      assert.equal(worker?.completedTurns, 3);
    } finally {
      restored.close();
    }
    const restoredAvatar = new AvatarStore(restoredAvatarDir);
    const readBack = await restoredAvatar.read(avatarId);
    assert.deepEqual(readBack?.data, makePng(24, 32));

    assert.ok(existsSync(restoredMuxDbPath), "restored mux database must exist");
    const restoredMuxDb = new DatabaseSync(restoredMuxDbPath, { readOnly: true });
    try {
      const row = restoredMuxDb.prepare("SELECT cwd FROM mux_terminal_tabs WHERE id = ?").get("terminal-1") as { cwd?: string } | undefined;
      assert.equal(row?.cwd, "/repo");
    } finally {
      restoredMuxDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Hand-builds a minimal, valid single-entry POSIX ustar archive so the
// path-escape test doesn't depend on getting the real `tar` package to
// *emit* a malicious path (it won't, by design) — this constructs the wire
// format directly, the same way a hostile or corrupted backup file could.
function buildUstarEntry(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "ascii");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(content.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.write("        ", 148, "ascii"); // checksum placeholder
  header.write("0", 156, "ascii"); // typeflag: regular file
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");

  const paddedContentLength = Math.ceil(content.length / 512) * 512;
  const paddedContent = Buffer.alloc(paddedContentLength);
  content.copy(paddedContent);
  return Buffer.concat([header, paddedContent]);
}

function buildTarGz(entries: Array<{ name: string; content: Buffer }>): Buffer {
  const parts = entries.map((entry) => buildUstarEntry(entry.name, entry.content));
  const endOfArchive = Buffer.alloc(1024);
  return gzipSync(Buffer.concat([...parts, endOfArchive]));
}

test("rejects a hand-crafted tar entry that tries to escape the staging directory via ..", async () => {
  const root = mkdtempSync(join(tmpdir(), "pixel-crew-backup-tarslip-"));
  try {
    const archivePath = join(root, "evil.tar.gz");
    writeFileSync(archivePath, buildTarGz([
      { name: "../../outside-marker.txt", content: Buffer.from("should never land outside staging") },
    ]));

    const stagingDir = join(root, "staging");
    await assert.rejects(extractAndValidateBackup(archivePath, stagingDir), /不安全的路徑/);
    assert.equal(existsSync(join(root, "outside-marker.txt")), false);
    assert.equal(existsSync(join(tmpdir(), "outside-marker.txt")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a hand-crafted symlink-typed tar entry pointing outside the staging directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "pixel-crew-backup-tarsymlink-"));
  try {
    const header = Buffer.alloc(512);
    header.write("escape-link", 0, "ascii");
    header.write("0000644\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write("00000000000\0", 124, "ascii");
    header.write("00000000000\0", 136, "ascii");
    header.write("        ", 148, "ascii");
    header.write("2", 156, "ascii"); // typeflag: symbolic link
    header.write("/etc/passwd", 157, "ascii"); // linkname
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    const archivePath = join(root, "symlink.tar.gz");
    writeFileSync(archivePath, gzipSync(Buffer.concat([header, Buffer.alloc(1024)])));

    const stagingDir = join(root, "staging");
    await assert.rejects(extractAndValidateBackup(archivePath, stagingDir), /不允許的檔案類型/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects archive entries outside the fixed Pixel Crew backup layout", async () => {
  const root = mkdtempSync(join(tmpdir(), "pixel-crew-backup-unknown-entry-"));
  try {
    const archivePath = join(root, "unknown-entry.tar.gz");
    writeFileSync(archivePath, buildTarGz([
      { name: "unrelated/large-junk.bin", content: Buffer.from("junk") },
    ]));

    await assert.rejects(
      extractAndValidateBackup(archivePath, join(root, "staging")),
      /包含未知項目/,
    );
    assert.equal(existsSync(join(root, "staging", "unrelated", "large-junk.bin")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an archive whose db file has the wrong magic header", async () => {
  const root = mkdtempSync(join(tmpdir(), "pixel-crew-backup-badmagic-"));
  try {
    const stagingDir = join(root, "staging");
    mkdirSync(join(stagingDir, "db"), { recursive: true });
    mkdirSync(join(stagingDir, "avatars"), { recursive: true });
    mkdirSync(join(stagingDir, "mux"), { recursive: true });
    writeFileSync(join(stagingDir, "db", "cockpit.sqlite"), "not a real sqlite file at all");
    writeFileSync(join(stagingDir, "manifest.json"), JSON.stringify({ formatVersion: 1, exportedAt: "x", appVersion: "1.0.0" }));

    const archivePath = join(root, "bad-magic.tar.gz");
    await buildArchive(stagingDir, archivePath);

    await assert.rejects(
      extractAndValidateBackup(archivePath, join(root, "validate")),
      /資料庫檔案格式無效/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a structurally valid but schema-empty SQLite file", async () => {
  const root = mkdtempSync(join(tmpdir(), "pixel-crew-backup-noschema-"));
  try {
    const stagingDir = join(root, "staging");
    mkdirSync(join(stagingDir, "db"), { recursive: true });
    mkdirSync(join(stagingDir, "avatars"), { recursive: true });
    mkdirSync(join(stagingDir, "mux"), { recursive: true });
    // A real, empty SQLite database — passes the magic header and integrity
    // check, but lacks the tables Pixel Crew actually needs.
    const emptyDb = new LocalStore(join(root, "throwaway-real.sqlite"));
    emptyDb.close();
    // LocalStore always creates the full schema; simulate a genuinely
    // foreign/empty SQLite file by writing a minimal valid one directly.
    const { DatabaseSync } = await import("node:sqlite");
    const bareDb = new DatabaseSync(join(stagingDir, "db", "cockpit.sqlite"));
    bareDb.exec("CREATE TABLE unrelated (id INTEGER)");
    bareDb.close();
    writeFileSync(join(stagingDir, "manifest.json"), JSON.stringify({ formatVersion: 1, exportedAt: "x", appVersion: "1.0.0" }));

    const archivePath = join(root, "no-schema.tar.gz");
    await buildArchive(stagingDir, archivePath);

    await assert.rejects(
      extractAndValidateBackup(archivePath, join(root, "validate")),
      /缺少必要的資料表/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a healthy SQLite mux database with an incompatible schema", async () => {
  const root = mkdtempSync(join(tmpdir(), "pixel-crew-backup-bad-mux-schema-"));
  try {
    const stagingDir = join(root, "staging");
    mkdirSync(join(stagingDir, "db"), { recursive: true });
    mkdirSync(join(stagingDir, "avatars"), { recursive: true });
    mkdirSync(join(stagingDir, "mux"), { recursive: true });
    const store = new LocalStore(join(stagingDir, "db", "cockpit.sqlite"));
    store.close();
    const muxDb = new DatabaseSync(join(stagingDir, "mux", "terminal-mux.sqlite"));
    muxDb.exec("CREATE TABLE mux_terminal_tabs (id TEXT PRIMARY KEY, cwd TEXT NOT NULL)");
    muxDb.close();
    writeFileSync(join(stagingDir, "manifest.json"), JSON.stringify({ formatVersion: 2, exportedAt: "x", appVersion: "2.2.2" }));
    const archivePath = join(root, "bad-mux-schema.tar.gz");
    await buildArchive(stagingDir, archivePath);
    await assert.rejects(extractAndValidateBackup(archivePath, join(root, "validate")), /黑窗工作階段資料庫缺少必要/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback restores both the original DB and avatars after a mid-swap failure", () => {
  const root = mkdtempSync(join(tmpdir(), "pixel-crew-backup-rollback-"));
  try {
    const dbPath = join(root, "cockpit.sqlite");
    const avatarDir = join(root, "avatars");
    writeFileSync(dbPath, "ORIGINAL_DB_CONTENT");
    mkdirSync(avatarDir);
    writeFileSync(join(avatarDir, "original.txt"), "ORIGINAL_AVATAR_CONTENT");

    const snapshotDir = join(root, "pre-restore");
    snapshotCurrentData({ dbPath, avatarDir }, snapshotDir);
    assert.equal(existsSync(dbPath), false);
    assert.equal(existsSync(avatarDir), false);

    // Craft a staged replacement whose db swap will succeed but whose
    // avatars swap fails — the target avatarDir path is occupied by a
    // non-empty directory, so moving a directory onto it throws on every
    // supported platform.
    const stagingDir = join(root, "staging");
    mkdirSync(join(stagingDir, "db"), { recursive: true });
    writeFileSync(join(stagingDir, "db", "cockpit.sqlite"), "NEW_DB_CONTENT");
    mkdirSync(join(stagingDir, "avatars"), { recursive: true });
    writeFileSync(join(stagingDir, "avatars", "new.txt"), "NEW_AVATAR_CONTENT");
    // A directory rename onto a regular file behaves differently on Windows.
    // A non-empty destination directory is a deterministic cross-platform
    // collision and still exercises the same mid-swap rollback path.
    mkdirSync(avatarDir);
    writeFileSync(join(avatarDir, "blocking.txt"), "block replacement");

    assert.throws(() => swapInRestoredData({ dbPath, avatarDir }, stagingDir));
    restoreFromSnapshot({ dbPath, avatarDir }, snapshotDir);

    assert.equal(readFileSync(dbPath, "utf8"), "ORIGINAL_DB_CONTENT");
    assert.equal(readFileSync(join(avatarDir, "original.txt"), "utf8"), "ORIGINAL_AVATAR_CONTENT");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore commit snapshots, swaps data, clears the pending import, then exits after the response", async () => {
  const root = mkdtempSync(join(tmpdir(), "pixel-crew-backup-commit-"));
  try {
    const dbPath = join(root, "cockpit.sqlite");
    const avatarDir = join(root, "avatars");
    const stagingDir = join(root, "staging");
    writeFileSync(dbPath, "ORIGINAL_DB_CONTENT");
    mkdirSync(avatarDir);
    writeFileSync(join(avatarDir, "original.txt"), "ORIGINAL_AVATAR_CONTENT");
    mkdirSync(join(stagingDir, "db"), { recursive: true });
    mkdirSync(join(stagingDir, "avatars"));
    writeFileSync(join(stagingDir, "db", "cockpit.sqlite"), "RESTORED_DB_CONTENT");
    writeFileSync(join(stagingDir, "avatars", "restored.txt"), "RESTORED_AVATAR_CONTENT");

    const harness = createResponseHarness();
    const calls: string[] = [];
    let exitCode: number | undefined;
    await commitBackupRestore({
      response: harness.response,
      importToken: "valid-import",
      confirmPhrase: "RESTORE",
      pending: { stagingDir },
      maintenance: false,
      setMaintenance: (value) => calls.push(`maintenance:${value}`),
      stopWorkers: () => calls.push("stopWorkers"),
      flush: () => calls.push("flush"),
      checkpoint: () => calls.push("checkpoint"),
      stopTerminalMux: async () => { calls.push("stopTerminalMux"); },
      closeStore: () => calls.push("closeStore"),
      discardPending: (token) => calls.push(`discard:${token}`),
      dataDirectory: root,
      dbPath,
      avatarDir,
      exit: (code) => { exitCode = code; },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(harness.statusCode(), 200);
    assert.deepEqual(harness.body(), {
      ok: true,
      message: "還原完成，請重新啟動 Pixel Crew",
      preRestoreSnapshot: (harness.body() as { preRestoreSnapshot: string }).preRestoreSnapshot,
    });
    assert.deepEqual(calls, [
      "maintenance:true", "stopWorkers", "flush", "checkpoint", "stopTerminalMux", "closeStore", "discard:valid-import",
    ]);
    assert.equal(exitCode, 0);
    assert.equal(readFileSync(dbPath, "utf8"), "RESTORED_DB_CONTENT");
    assert.equal(readFileSync(join(avatarDir, "restored.txt"), "utf8"), "RESTORED_AVATAR_CONTENT");
    assert.equal(existsSync(join(root, ".last-restore-result.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
