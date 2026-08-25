/**
 * Bot operations -- backup creation + listing only, per the Phase 2 plan's
 * explicit scope decision. NO restore endpoint exists here, not even
 * Owner-gated -- restoring overwrites live db/ files and stays a
 * manual/Discord-side action for now (highest blast-radius feature in
 * the whole app; deliberately excluded rather than half-built).
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
import { ZipArchive } from "archiver";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { config } from "../config.js";
import { resolveAuthContext } from "../auth/context.js";
import { logAppAction } from "../audit.js";

async function ensureBackupsDir(): Promise<void> {
  await mkdir(config.backupsDir, { recursive: true });
}

/** Snapshots every db/*.sqlite into a temp dir via better-sqlite3's
 * online-backup API, verifies each copy with PRAGMA integrity_check
 * (failing the whole operation rather than shipping a bad backup), zips
 * them + a README, and writes the result into config.backupsDir. Returns
 * the created file's name. */
async function createBackup(triggeredBy: string): Promise<string> {
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
    const filename = `manual_${timestamp}.zip`;
    const destPath = join(config.backupsDir, filename);

    await new Promise<void>((resolvePromise, reject) => {
      const output = createWriteStream(destPath);
      const archive = new ZipArchive({ zlib: { level: 9 } });
      output.on("close", () => resolvePromise());
      archive.on("error", reject);
      output.on("error", reject);
      archive.pipe(output);
      archive.directory(stagingDir, false);
      archive.finalize();
    });

    return filename;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

export default async function backupRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", fastify.requireAuth);

  fastify.get("/admin/backups", async (request, reply) => {
    const ctx = await resolveAuthContext(request.session!);
    if (!ctx.isOwner) {
      return reply.code(403).send({ error: "owner_required" });
    }

    await ensureBackupsDir();
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
}
