import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import Layout from "../components/Layout";
import {
  getBackups,
  createBackup,
  getBackupDownloadUrl,
  validateRestoreZip,
  confirmRestore,
  cancelRestore,
  type RestoreValidation,
} from "../api/client";
import { Card, EmptyState, ErrorState, LoadingState, SectionHeading, Shield, buttonDanger, buttonPrimary, buttonSecondary } from "../components/ui";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const RETENTION_DAYS = 7;

function daysUntilExpiry(createdAt: string): number {
  const expiresAt = new Date(createdAt).getTime() + RETENTION_DAYS * 86_400_000;
  return Math.ceil((expiresAt - Date.now()) / 86_400_000);
}

function expiryTone(daysLeft: number): string {
  if (daysLeft >= 5) return "text-up-ink";
  if (daysLeft >= 2) return "text-gold-ink";
  return "text-down-ink";
}

const CONFIRM_PHRASE = "RESTORE";

/** Owner-only. Backup creation/listing plus restore -- the highest
 * blast-radius action in the whole app, so this mirrors every safeguard
 * the Discord bot's own /restore command has (see routes/backups.ts's
 * doc comment): validate-then-confirm as two separate steps, an
 * automatic safety backup of current data before anything is touched,
 * and a typed confirmation phrase on top of that since there's no
 * Discord-style ephemeral-prompt friction to lean on here. */
export default function AdminBackups() {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-backups"],
    queryFn: getBackups,
  });

  const createMutation = useMutation({
    mutationFn: createBackup,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-backups"] }),
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");
  const [validation, setValidation] = useState<RestoreValidation | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [restoreDone, setRestoreDone] = useState<{ safetyBackupFilename: string; restoredNames: string[] } | null>(null);

  const validateMutation = useMutation({
    mutationFn: (file: File) => validateRestoreZip(file, password),
    onSuccess: (result) => {
      setValidation(result);
      setConfirmText("");
    },
  });

  const confirmMutation = useMutation({
    mutationFn: () => confirmRestore(validation!.token),
    onSuccess: (result) => {
      setRestoreDone(result);
      setValidation(null);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelRestore(validation!.token),
    onSuccess: () => {
      setValidation(null);
      setConfirmText("");
      setPassword("");
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) validateMutation.mutate(file);
  };

  const confirmDisabled = confirmText !== CONFIRM_PHRASE || confirmMutation.isPending;

  return (
    <Layout
      title="Backups"
      backTo={{ to: "/admin", label: "Admin" }}
      eyebrow={
        <span className="flex items-center gap-2">
          <span className="rounded-pill bg-gradient-to-b from-[var(--gold-fill-from)] to-[var(--gold-fill-to)] px-2 py-0.5 font-mono text-[10px] font-bold tracking-pill text-on-gold uppercase">
            Owner only
          </span>
          <span className="font-mono text-[11px] text-ink-faint uppercase">
            {data ? `${data.length} backups` : ""} · deleted after {RETENTION_DAYS} days
          </span>
        </span>
      }
    >
      <Card>
        <SectionHeading>Create a backup</SectionHeading>
        <button onClick={() => createMutation.mutate()} disabled={createMutation.isPending} className={buttonPrimary}>
          {createMutation.isPending ? "Creating…" : "Create backup"}
        </button>
        {createMutation.isSuccess && <span className="ml-3 text-sm text-up-ink">Created {createMutation.data.filename}</span>}
        {createMutation.isError && <span className="ml-3 text-sm text-down-ink">Backup failed.</span>}
      </Card>

      {isLoading && <LoadingState />}
      {error && <ErrorState message="Couldn't load backups." onRetry={refetch} />}
      {data && data.length === 0 && <EmptyState>No backups yet.</EmptyState>}

      {data && data.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="overflow-x-auto rounded-card border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-header text-left font-mono text-[10px] tracking-eyebrow text-ink-faint uppercase">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Size</th>
                  <th className="px-4 py-2 font-medium">Created</th>
                  <th className="px-4 py-2 font-medium">Expires</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-hairline">
                {data.map((b, i) => {
                  const daysLeft = daysUntilExpiry(b.createdAt);
                  return (
                    <tr key={b.name} className={i % 2 === 1 ? "bg-surface-panel-alt" : undefined}>
                      <td className="px-4 py-2">
                        <a href={getBackupDownloadUrl(b.name)} download={b.name} className="flex items-center gap-1.5 font-mono text-info-ink hover:text-text">
                          <Download size={14} strokeWidth={1.75} aria-hidden="true" />
                          {b.name}
                        </a>
                      </td>
                      <td className="px-4 py-2 font-mono text-ink-secondary">{formatBytes(b.sizeBytes)}</td>
                      <td className="px-4 py-2 font-mono text-ink-secondary">{new Date(b.createdAt).toLocaleString()}</td>
                      <td className={`px-4 py-2 font-mono ${expiryTone(daysLeft)}`}>{daysLeft <= 0 ? "today" : `${daysLeft}d`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-ink-faint">Click a name to download it.</p>
        </div>
      )}

      <Card className="border-down-border">
        <div className="mb-3 flex items-center gap-2.5">
          <Shield size={40} tone="danger">
            !
          </Shield>
          <div>
            <SectionHeading>Restore from a backup</SectionHeading>
            <p className="-mt-2 text-xs text-ink-muted">This overwrites all current bot data. Nothing here is undone automatically.</p>
          </div>
        </div>

        {restoreDone ? (
          <div className="flex flex-col gap-2 text-sm">
            <p className="text-up-ink">Restore complete: {restoreDone.restoredNames.join(", ")}.</p>
            <p className="text-ink-secondary">
              A safety backup of the data from just before this restore was saved as{" "}
              <span className="font-mono text-ink">{restoreDone.safetyBackupFilename}</span> — restore that one if
              something looks wrong.
            </p>
            <p className="rounded-control border border-gold-border bg-gold-tint px-3 py-2 text-gold-ink">
              This web server is restarting now to load the restored data — this page will stop responding for a
              moment, then you can refresh it. You must also separately restart the Discord bot for it to see the
              restored data.
            </p>
          </div>
        ) : validation ? (
          <div className="flex flex-col gap-3 text-sm">
            <p className="rounded-control border border-down-border bg-down-tint px-3 py-2 text-down-ink">
              This will overwrite ALL current bot data — every alliance's Vault Trap/Capitol War history, member
              registrations, admin permissions, settings, everything — with the contents of this backup. A safety
              backup of the current data is taken automatically first, so this can be undone by restoring that
              safety backup afterward if something's wrong.
            </p>
            <div>
              <p className="mb-1.5 text-ink-muted">
                Files to restore ({validation.restoredNames.length}, {formatBytes(validation.totalSizeBytes)}):
              </p>
              <ul className="flex flex-col gap-0.5">
                {validation.restoredNames.map((n) => (
                  <li key={n} className="font-mono text-up-ink">
                    will be restored — {n}
                  </li>
                ))}
              </ul>
            </div>
            {validation.missingFromZip.length > 0 && (
              <p className="font-mono text-xs text-gold-ink">not in backup — left alone: {validation.missingFromZip.join(", ")}</p>
            )}
            <p className="text-gold-ink">
              The web server and the Discord bot must both be restarted afterward to load the restored data —
              neither happens automatically.
            </p>
            <label className="block">
              <span className="mb-1 block text-xs text-ink-muted">Type {CONFIRM_PHRASE} to confirm</span>
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={CONFIRM_PHRASE}
                className="w-full max-w-xs rounded-control border border-down-border bg-surface-sunken px-3 py-2 font-mono text-sm text-ink"
              />
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => confirmMutation.mutate()}
                disabled={confirmDisabled}
                style={{ opacity: confirmDisabled ? 0.45 : 1 }}
                className={buttonDanger}
              >
                {confirmMutation.isPending ? "Restoring…" : "Confirm restore"}
              </button>
              <button onClick={() => cancelMutation.mutate()} disabled={cancelMutation.isPending} className={buttonSecondary}>
                Cancel
              </button>
            </div>
            {confirmMutation.isError && <p className="text-down-ink">{(confirmMutation.error as Error).message}</p>}
          </div>
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            <p className="text-ink-muted">
              Upload a backup .zip to check it before anything is touched — nothing under db/ changes until you
              confirm on the next screen.
            </p>
            <div className="rounded-card border border-dashed border-line-strong p-4">
              <label className="mb-1 block text-xs text-ink-muted">Backup .zip</label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip"
                onChange={handleFileChange}
                disabled={validateMutation.isPending}
                className="block w-full text-sm text-ink-secondary"
              />
              <p className="mt-2 text-xs text-ink-faint">
                AES-encrypted backups (the Discord bot's password-protected export) aren't supported here — use
                Discord's <code className="font-mono text-info-ink">/restore</code> command for those instead.
              </p>
            </div>
            <label className="block">
              <span className="mb-1 block text-xs text-ink-muted">Password (only if this backup uses one)</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full max-w-xs rounded-control border border-line bg-surface-sunken px-3 py-2 text-sm text-ink"
              />
            </label>
            {validateMutation.isPending && <LoadingState label="Validating…" />}
            {validateMutation.isError && <p className="text-down-ink">{(validateMutation.error as Error).message}</p>}
          </div>
        )}
      </Card>
    </Layout>
  );
}
