/**
 * Bot operations -- backup creation/listing/download, automatic 7-day
 * expiry, and (as of this stage) web-based restore. Restore was
 * deliberately excluded from the original
 * Phase 2 plan as "the highest blast-radius feature in the whole app" --
 * this reverses that decision on explicit request, so it's built to the
 * same (or higher) safety bar as the Discord bot's own `/restore` command
 * (see cogs/bot_backup.py), not a stripped-down copy:
 *
 *  - Owner tier only, re-checked at both the validate AND confirm steps
 *    (a validated restore can sit unconfirmed for a while).
 *  - The uploaded zip is extracted into a staging directory and fully
 *    validated (safe filenames only, per-file `PRAGMA integrity_check`)
 *    BEFORE anything under db/ is touched -- a bad upload never leaves
 *    live data half-overwritten.
 *  - A fresh safety backup of the CURRENT data is taken automatically
 *    immediately before the swap, so a bad restore can itself be undone.
 *  - AES-encrypted backups (the bot's own password-protected export
 *    format) are explicitly rejected with a clear message rather than
 *    silently mis-decrypting -- adm-zip only implements classic ZipCrypto,
 *    not WinZip AES, so trying anyway would either throw an opaque error
 *    or (worse) "succeed" with garbage bytes. The per-file integrity check
 *    would still catch that before it reached db/, but a clear upfront
 *    error is far better UX than a confusing failure.
 *  - This process holds long-lived SQLite connections for the entire app
 *    (db/connections.ts) -- they cannot be safely swapped out from under
 *    running route handlers without a full process restart, so a
 *    confirmed restore closes them, replaces the files, and exits the
 *    process (same shutdown idiom server.ts already uses for SIGINT/
 *    SIGTERM) rather than pretend the in-memory connections still see
 *    the new data. The admin is told plainly to restart both this
 *    process and the Discord bot afterward.
 *
 * Backup creation is reimplemented in Node, not proxied to the Python
 * bot -- there's no IPC/HTTP channel between the two processes.
 * better-sqlite3's `.backup()` uses the same SQLite online-backup
 * mechanism (WAL-safe, consistent snapshot even while the bot is
 * actively writing) the Python side's own backup cog relies on. Every
 * `db/*.sqlite` file is discovered dynamically (not a hardcoded list) so
 * this stays correct as the bot adds more db files over time. Plain
 * DEFLATE zip, no password/encryption -- matches the bot's own
 * unencrypted-by-default path (see cogs/bot_backup.py).
 */
import type { FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import AdmZip from "adm-zip";
import { ZipArchive } from "archiver";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join, basename } from "node:path";
import { config } from "../config.js";
import { resolveAuthContext } from "../auth/context.js";
import { logAppAction } from "../audit.js";
import { closeAllConnections } from "../db/connections.js";

async function ensureBackupsDir(): Promise<void> {
  await mkdir(config.backupsDir, { recursive: true });
}

// Applies to every .zip in the shared backups/ directory -- this app and
// the Discord bot both write into it (see the module doc comment's
// "sibling of botDbDir" note), and there's no reliable way to tell a
// web-created backup apart from a bot-created one by filename alone
// (both use the same "manual_"/"automatic_" prefixes). A flat age-based
// expiry here is simpler and more predictable than trying to guess
// origin, at the cost of also pruning old bot-created backups that sit
// past a week -- the bot's own count-based retention (keep_manual/
// keep_automatic) is unaffected since that's enforced separately, on its
// own schedule, against whatever's left.
const BACKUP_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Deletes every backup zip older than BACKUP_EXPIRY_MS. Returns the
 * names actually removed (empty array on a clean sweep) -- never throws
 * for an individual file's delete failure, since one locked/already-gone
 * file shouldn't block pruning the rest. */
async function pruneExpiredBackups(): Promise<string[]> {
  await ensureBackupsDir();
  const files = await readdir(config.backupsDir);
  const zips = files.filter((f) => f.endsWith(".zip"));
  const cutoff = Date.now() - BACKUP_EXPIRY_MS;

  const removed: string[] = [];
  for (const name of zips) {
    const path = join(config.backupsDir, name);
    try {
      const s = await stat(path);
      if (s.mtime.getTime() < cutoff) {
        await rm(path, { force: true });
        removed.push(name);
      }
    } catch {
      // Already gone, or a transient stat/rm failure -- skip it, the
      // next sweep will catch it if it's still there and still expired.
    }
  }

  // "system" as actor, matching this codebase's existing convention for
  // bot-side automatic actions with no specific admin behind them (see
  // cogs/bot_backup.py's automatic_backup_loop) -- so "where did my
  // backup go" is answerable from the audit log rather than a silent
  // deletion.
  for (const name of removed) {
    await logAppAction({
      actorId: "system",
      guildId: null,
      action: "backup_expired",
      resourceType: "backup",
      resourceId: name,
      detail: `Auto-deleted after ${BACKUP_EXPIRY_MS / (24 * 60 * 60 * 1000)} days`,
    });
  }

  return removed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Defense-in-depth for a rename landing right after closeAllConnections():
 * the actual bug that caused this in testing is fixed at the source (see
 * that function's doc comment), but a real deployment can still have
 * something else transiently touch one of these files at the wrong
 * moment (antivirus, an indexer, a sync client if db/ happens to live
 * inside one -- as this checkout's db-dev-copy/ did during testing,
 * which is what surfaced the real bug in the first place). Retrying the
 * busy files in round-robin (rather than exhausting all attempts on file
 * N before ever trying file N+1) means the real wall-clock time spent
 * processing every OTHER file in the batch already gives an early
 * straggler room to clear, so this converges far faster in practice than
 * a naive per-file retry loop. Any non-retryable error aborts the whole
 * batch immediately. */
async function renameAllWithRetry(
  log: { warn: (msg: string) => void },
  moves: { src: string; dest: string }[],
  maxRounds = 8,
  delayMs = 1500,
): Promise<void> {
  let remaining = moves;
  for (let round = 0; round < maxRounds && remaining.length > 0; round++) {
    const stillBusy: typeof moves = [];
    for (const move of remaining) {
      try {
        await rename(move.src, move.dest);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EBUSY") throw err;
        stillBusy.push(move);
      }
    }
    remaining = stillBusy;
    if (remaining.length > 0) {
      log.warn(
        `renameAllWithRetry: round ${round + 1}/${maxRounds}, ${remaining.length} file(s) still busy ` +
          `(${remaining.map((m) => basename(m.dest)).join(", ")}), retrying`,
      );
      await sleep(delayMs);
    }
  }
  if (remaining.length > 0) {
    throw new Error(
      `Could not replace: ${remaining.map((m) => basename(m.dest)).join(", ")} -- still busy after retrying.`,
    );
  }
}

/** Snapshots every db/*.sqlite into a temp dir via better-sqlite3's
 * online-backup API, verifies each copy with PRAGMA integrity_check
 * (failing the whole operation rather than shipping a bad backup), zips
 * them + a README, and writes the result into config.backupsDir. Returns
 * the created file's name. `typePrefix` distinguishes a pre-restore
 * safety snapshot from an ordinary manual one in the file listing. */
async function createBackup(triggeredBy: string, typePrefix: "manual" | "presafety" = "manual"): Promise<string> {
  const sourceFiles = (await readdir(config.botDbDir)).filter((f) => f.endsWith(".sqlite"));
  if (sourceFiles.length === 0) {
    throw new Error(`No .sqlite files found in ${config.botDbDir}`);
  }

  const stagingDir = await mkdtemp(join(tmpdir(), "pcb-backup-"));
  try {
    for (const file of sourceFiles) {
      const src = new Database(join(config.botDbDir, file), { readonly: true });
      try {
        await src.backup(join(stagingDir, file));
      } finally {
        src.close();
      }

      const copy = new Database(join(stagingDir, file), { readonly: true });
      try {
        const result = copy.pragma("integrity_check") as { integrity_check: string }[];
        const ok = result.length === 1 && result[0]?.integrity_check === "ok";
        if (!ok) {
          throw new Error(`Integrity check failed for ${file}: ${JSON.stringify(result)}`);
        }
      } finally {
        copy.close();
      }
    }

    await writeFile(
      join(stagingDir, "README.txt"),
      `Police Chief Bot database backup\n` +
        `Created: ${new Date().toISOString()}\n` +
        `Triggered by: Discord user ${triggeredBy} via the web dashboard\n` +
        `Files: ${sourceFiles.join(", ")}\n`,
    );

    await ensureBackupsDir();
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
    const filename = `${typePrefix}_${timestamp}.zip`;
    const destPath = join(config.backupsDir, filename);

    await new Promise<void>((resolvePromise, reject) => {
      const output = createWriteStream(destPath);
      const archive = new ZipArchive({ zlib: { level: 9 } });
      output.on("close", () => resolvePromise());
      archive.on("error", reject);
      output.on("error", reject);
      archive.pipe(output);
      // Explicit file list, NOT archive.directory(stagingDir, false) --
      // opening a WAL-mode database's backed-up copy (even readonly, for
      // the integrity check above) makes SQLite create -shm/-wal sidecar
      // files alongside it in stagingDir. Zipping the whole directory
      // silently pulled those empty sidecars into every backup, which a
      // strict restore validator (only *.sqlite / README.txt allowed)
      // then rejects outright as an "unexpected entry".
      for (const file of sourceFiles) {
        archive.file(join(stagingDir, file), { name: file });
      }
      archive.file(join(stagingDir, "README.txt"), { name: "README.txt" });
      archive.finalize();
    });

    return filename;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

// Only a bare "name.sqlite" (no path separators, no "..") is ever accepted
// out of a restore zip -- rejects zip-slip attempts (entries that would
// write outside the staging dir) outright rather than trying to sanitize
// them. Mirrors cogs/bot_backup.py's _RESTORE_SQLITE_NAME_RE exactly.
const RESTORE_SQLITE_NAME_RE = /^[A-Za-z0-9_-]+\.sqlite$/;
// WinZip AES stores 99 as the on-disk "compression method" for every
// AES-encrypted entry (the real method lives inside the AES extra field);
// adm-zip only implements classic ZipCrypto decryption, not AES, so this
// is how an AES entry (the bot's own password-protected export format)
// is told apart from a ZipCrypto one or a plain one.
const AES_COMPRESSION_METHOD = 99;
// @types/adm-zip misspells this getter as "encripted" in EntryHeader,
// which doesn't match the real runtime property ("encrypted", see
// node_modules/adm-zip/headers/entryHeader.js) -- so the correctly-spelled
// access below has to go through a cast rather than the declared type.
function isEntryEncrypted(entry: AdmZip.IZipEntry): boolean {
  return Boolean((entry.header as unknown as { encrypted?: boolean }).encrypted);
}

// How long a validated-but-unconfirmed restore stays staged before its
// extracted files are swept away. Generous compared to the Discord bot's
// 5-minute prompt timeout since a web admin may need to read the file
// list/warnings more carefully before confirming.
const RESTORE_TOKEN_TTL_MS = 10 * 60 * 1000;

interface PendingRestore {
  stageDir: string;
  restoredNames: string[];
  missingFromZip: string[];
  ownerId: string;
  createdAt: number;
}

const pendingRestores = new Map<string, PendingRestore>();

async function discardPendingRestore(token: string): Promise<void> {
  const pending = pendingRestores.get(token);
  if (!pending) return;
  pendingRestores.delete(token);
  await rm(pending.stageDir, { recursive: true, force: true });
}

setInterval(() => {
  const now = Date.now();
  for (const [token, pending] of pendingRestores) {
    if (now - pending.createdAt > RESTORE_TOKEN_TTL_MS) {
      void discardPendingRestore(token);
    }
  }
}, 60_000).unref();

// Backup expiry doesn't only run reactively off GET /admin/backups --
// this sweeps in the background too, so disk space is actually
// reclaimed even if nobody opens the page for weeks (a fresh process
// start always runs one immediately, then every 6h after).
void pruneExpiredBackups();
setInterval(() => void pruneExpiredBackups(), 6 * 60 * 60 * 1000).unref();

/** Extracts every valid, safely-named *.sqlite member from a backup zip
 * into destDir, then integrity-checks each one before returning. Throws
 * an Error with a human-readable message on ANY problem: not a valid
 * zip, a wrong/missing password, a suspicious member name (zip-slip
 * attempt -- rejects the WHOLE zip rather than silently skipping just
 * that entry, since a crafted zip is reason enough not to trust anything
 * else in it either), an AES-encrypted entry (unsupported here -- see the
 * module doc comment), zero valid members, or a failed integrity check.
 * Nothing gets written outside destDir, so a validation failure here can
 * never leave live data half-overwritten.
 *
 * Returns `missingFromZip` (informational only): which of the currently
 * present db/*.sqlite files this backup doesn't include (e.g. an older
 * backup predating a newer feature's own db file), so the confirmation
 * step can surface it without treating it as an error. */
async function validateAndExtractRestoreZip(
  zipPath: string,
  password: string | undefined,
  destDir: string,
): Promise<{ restoredNames: string[]; missingFromZip: string[] }> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipPath);
  } catch (err) {
    throw new Error(`Not a valid zip file: ${(err as Error).message}`);
  }

  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  const validNames: string[] = [];
  for (const entry of entries) {
    if (entry.entryName === "README.txt") continue;
    if (!RESTORE_SQLITE_NAME_RE.test(entry.entryName)) {
      throw new Error(
        `Refusing to restore: unexpected entry "${entry.entryName}" in the backup zip ` +
          `(only plain *.sqlite filenames are allowed). This zip may be corrupted or tampered with.`,
      );
    }
    if (isEntryEncrypted(entry) && entry.header.method === AES_COMPRESSION_METHOD) {
      throw new Error(
        `"${entry.entryName}" is AES-encrypted. The web restore only supports unencrypted backups ` +
          `(or ones with the older, weaker ZipCrypto password) -- use Discord's /restore command for ` +
          `an AES password-protected backup instead.`,
      );
    }
    validNames.push(entry.entryName);
  }

  if (validNames.length === 0) {
    throw new Error("This backup zip contains no .sqlite files.");
  }

  for (const name of validNames) {
    const entry = zip.getEntry(name)!;
    const encrypted = isEntryEncrypted(entry);
    let data: Buffer;
    try {
      data = encrypted
        ? (zip.readFile(entry, password ? Buffer.from(password) : undefined) ?? Buffer.alloc(0))
        : (zip.readFile(entry) ?? Buffer.alloc(0));
    } catch (err) {
      throw new Error(`Could not read "${name}" (wrong password?): ${(err as Error).message}`);
    }
    if (encrypted && data.length === 0 && entry.header.size > 0) {
      throw new Error(`Could not read "${name}" -- wrong or missing password.`);
    }
    await writeFile(join(destDir, name), data);
  }

  for (const name of validNames) {
    const destPath = join(destDir, name);
    const conn = new Database(destPath, { readonly: true });
    try {
      let result: { integrity_check: string }[];
      try {
        result = conn.pragma("integrity_check") as { integrity_check: string }[];
      } catch (err) {
        throw new Error(`"${name}" is not a valid SQLite database (${(err as Error).message}) -- refusing to restore a corrupted database file.`);
      }
      const ok = result.length === 1 && result[0]?.integrity_check === "ok";
      if (!ok) {
        throw new Error(`"${name}" failed its integrity check (${JSON.stringify(result)}) -- refusing to restore a corrupted database file.`);
      }
    } finally {
      conn.close();
    }
  }

  let currentNames: Set<string>;
  try {
    currentNames = new Set((await readdir(config.botDbDir)).filter((f) => f.endsWith(".sqlite")));
  } catch {
    currentNames = new Set();
  }
  const missingFromZip = [...currentNames].filter((f) => !validNames.includes(f)).sort();

  return { restoredNames: [...validNames].sort(), missingFromZip };
}

export default async function backupRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", fastify.requireAuth);

  fastify.get("/admin/backups", async (request, reply) => {
    const ctx = await resolveAuthContext(request.session!);
    if (!ctx.isOwner) {
      return reply.code(403).send({ error: "owner_required" });
    }

    await pruneExpiredBackups();
    const files = await readdir(config.backupsDir);
    const zips = files.filter((f) => f.endsWith(".zip"));
    const withStats = await Promise.all(
      zips.map(async (name) => {
        const s = await stat(join(config.backupsDir, name));
        return { name: basename(name), sizeBytes: s.size, createdAt: s.mtime.toISOString() };
      }),
    );
    withStats.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return withStats;
  });

  // Filename comes straight from the URL -- validated against the exact
  // pattern createBackup() itself generates (no path separators or "..",
  // same spirit as the restore zip's own name check) before it ever
  // touches the filesystem, so this can't be used to read anything
  // outside backupsDir.
  fastify.get<{ Params: { filename: string } }>(
    "/admin/backups/:filename",
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      if (!ctx.isOwner) {
        return reply.code(403).send({ error: "owner_required" });
      }

      const { filename } = request.params;
      if (!/^[A-Za-z0-9_-]+\.zip$/.test(filename)) {
        return reply.code(400).send({ error: "invalid_filename" });
      }

      const path = join(config.backupsDir, filename);
      let size: number;
      try {
        size = (await stat(path)).size;
      } catch {
        return reply.code(404).send({ error: "backup_not_found" });
      }

      reply.header("Content-Type", "application/zip");
      reply.header("Content-Length", size);
      reply.header("Content-Disposition", `attachment; filename="${filename}"`);
      return reply.send(createReadStream(path));
    },
  );

  fastify.post(
    "/admin/backups",
    { preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      if (!ctx.isOwner) {
        return reply.code(403).send({ error: "owner_required" });
      }

      try {
        const filename = await createBackup(ctx.discordId);
        await logAppAction({
          actorId: ctx.discordId,
          guildId: null,
          action: "backup_triggered",
          resourceType: "backup",
          resourceId: filename,
        });
        return reply.code(201).send({ ok: true, filename });
      } catch (err) {
        request.log.error(err, "Backup creation failed");
        return reply.code(500).send({ error: "backup_failed" });
      }
    },
  );

  // ── Restore, step 1: upload + validate ──────────────────────────────
  // Extracts and fully validates the zip into a staging directory;
  // nothing under db/ is touched yet. Returns a short-lived token the
  // client must pass to /restore/confirm to actually apply it.
  fastify.post(
    "/admin/backups/restore/validate",
    { preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      if (!ctx.isOwner) {
        return reply.code(403).send({ error: "owner_required" });
      }

      const data = await request.file();
      if (!data) {
        return reply.code(400).send({ error: "no_file_uploaded" });
      }
      if (!data.filename.toLowerCase().endsWith(".zip")) {
        return reply.code(400).send({ error: "not_a_zip", message: "Please upload a .zip backup file." });
      }
      const password = typeof data.fields.password === "object" && "value" in data.fields.password
        ? (data.fields.password.value as string)
        : undefined;

      const token = randomUUID();
      const stageDir = join(config.backupsDir, ".restore-staging", token);
      await mkdir(stageDir, { recursive: true });
      const uploadPath = join(stageDir, "_upload.zip");

      try {
        await pipeline(data.file, createWriteStream(uploadPath));
        if (data.file.truncated) {
          throw new Error("That file is too large (limit 500 MB).");
        }
        const { restoredNames, missingFromZip } = await validateAndExtractRestoreZip(
          uploadPath,
          password?.trim() || undefined,
          stageDir,
        );

        let totalSizeBytes = 0;
        for (const name of restoredNames) {
          totalSizeBytes += (await stat(join(stageDir, name))).size;
        }

        pendingRestores.set(token, {
          stageDir,
          restoredNames,
          missingFromZip,
          ownerId: ctx.discordId,
          createdAt: Date.now(),
        });

        return { token, restoredNames, missingFromZip, totalSizeBytes };
      } catch (err) {
        await rm(stageDir, { recursive: true, force: true });
        return reply.code(400).send({ error: "validation_failed", message: (err as Error).message });
      } finally {
        await rm(uploadPath, { force: true }).catch(() => {});
      }
    },
  );

  // ── Restore, step 2: confirm ─────────────────────────────────────────
  // Re-verifies Owner tier (a validated restore can sit unconfirmed for
  // up to RESTORE_TOKEN_TTL_MS), takes a safety backup of the CURRENT
  // data first (aborting the whole restore if that fails), then swaps
  // the files in and deliberately exits the process -- see the module
  // doc comment for why this can't safely continue serving requests
  // in-place afterward.
  fastify.post<{ Body: { token?: string } }>(
    "/admin/backups/restore/confirm",
    { preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      if (!ctx.isOwner) {
        return reply.code(403).send({ error: "owner_required" });
      }

      const token = request.body?.token;
      const pending = token ? pendingRestores.get(token) : undefined;
      if (!pending) {
        return reply.code(400).send({ error: "restore_expired_or_not_found" });
      }
      if (pending.ownerId !== ctx.discordId) {
        return reply.code(403).send({ error: "not_your_restore" });
      }
      pendingRestores.delete(token!);

      let safetyBackupFilename: string;
      try {
        safetyBackupFilename = await createBackup(ctx.discordId, "presafety");
      } catch (err) {
        await rm(pending.stageDir, { recursive: true, force: true });
        request.log.error(err, "Pre-restore safety backup failed");
        return reply.code(500).send({
          error: "safety_backup_failed",
          message:
            "Could not create a safety backup of the current data, so the restore was NOT performed -- " +
            "refusing to overwrite data with no way back if something's wrong.",
        });
      }

      await logAppAction({
        actorId: ctx.discordId,
        guildId: null,
        action: "backup_restored",
        resourceType: "backup",
        resourceId: safetyBackupFilename,
        detail: `Restored: ${pending.restoredNames.join(", ")}`,
      });

      // Stop taking NEW requests before touching any file -- belt-and-
      // braces alongside closeAllConnections() below, so a request that
      // sneaks in against a database mid-close (or mid-query right as it
      // closes) can't hold a file open a moment longer than necessary.
      // Fastify's close() drains in-flight requests (this one included)
      // rather than aborting them, so this response still gets sent
      // normally.
      void request.server.close();
      await closeAllConnections();

      let writeError: string | null = null;
      try {
        await mkdir(config.botDbDir, { recursive: true });
        await renameAllWithRetry(
          request.log,
          pending.restoredNames.map((name) => ({
            src: join(pending.stageDir, name),
            dest: join(config.botDbDir, name),
          })),
        );
      } catch (err) {
        writeError = (err as Error).message;
        request.log.error(err, "Restore write failed");
      } finally {
        await rm(pending.stageDir, { recursive: true, force: true });
      }

      if (writeError) {
        reply.raw.once("finish", () => process.exit(1));
        return reply.code(500).send({
          error: "restore_write_failed",
          message: `${writeError} -- a safety backup of the pre-restore data was saved as "${safetyBackupFilename}". This process must be restarted; some database files may be in a mixed state.`,
          safetyBackupFilename,
        });
      }

      reply.raw.once("finish", () => process.exit(0));
      return {
        ok: true,
        safetyBackupFilename,
        restoredNames: pending.restoredNames,
      };
    },
  );

  fastify.delete<{ Body: { token?: string } }>(
    "/admin/backups/restore/cancel",
    { preHandler: fastify.csrfProtection },
    async (request, reply) => {
      const ctx = await resolveAuthContext(request.session!);
      if (!ctx.isOwner) {
        return reply.code(403).send({ error: "owner_required" });
      }
      const token = request.body?.token;
      if (token) await discardPendingRestore(token);
      return { ok: true };
    },
  );
}
