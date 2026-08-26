import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Card, EmptyState, ErrorState, LoadingState, SectionHeading, buttonDanger, buttonPrimary, buttonSecondary } from "../components/ui";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  const { data, isLoading, error } = useQuery({
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

  return (
    <Layout title="Backups" backTo={{ to: "/admin", label: "Admin" }}>
      <Card className="mb-6">
        <SectionHeading>Create a backup</SectionHeading>
        <button onClick={() => createMutation.mutate()} disabled={createMutation.isPending} className={buttonPrimary}>
          {createMutation.isPending ? "Creating…" : "Create backup"}
        </button>
        {createMutation.isSuccess && (
          <span className="ml-3 text-sm text-emerald-400">Created {createMutation.data.filename}</span>
        )}
        {createMutation.isError && <span className="ml-3 text-sm text-red-400">Backup failed.</span>}
      </Card>

      {isLoading && <LoadingState />}
      {error && <ErrorState message="Couldn't load backups." />}
      {data && data.length === 0 && <EmptyState icon="💾">No backups yet.</EmptyState>}

      {data && data.length > 0 && (
        <div className="mb-2 overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-left text-slate-400">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Size</th>
                <th className="px-4 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {data.map((b) => (
                <tr key={b.name} className="hover:bg-slate-900/60">
                  <td className="px-4 py-2">
                    <a
                      href={getBackupDownloadUrl(b.name)}
                      download={b.name}
                      className="font-mono text-indigo-400 hover:text-indigo-300"
                    >
                      {b.name}
                    </a>
                  </td>
                  <td className="px-4 py-2 text-slate-300">{formatBytes(b.sizeBytes)}</td>
                  <td className="px-4 py-2 text-slate-300">
                    {new Date(b.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.length > 0 && (
        <p className="mb-8 text-xs text-slate-500">
          Click a name to download it. Backups are deleted automatically 7 days after creation.
        </p>
      )}

      <Card className="border-red-900/60">
        <SectionHeading>Restore from a backup</SectionHeading>

        {restoreDone ? (
          <div className="space-y-2 text-sm">
            <p className="text-emerald-400">
              Restore complete: {restoreDone.restoredNames.join(", ")}.
            </p>
            <p className="text-slate-300">
              A safety backup of the data from just before this restore was saved as{" "}
              <span className="font-mono text-slate-100">{restoreDone.safetyBackupFilename}</span> --
              restore that one if something looks wrong.
            </p>
            <p className="rounded border border-amber-900 bg-amber-950/40 px-3 py-2 text-amber-300">
              This web server is restarting now to load the restored data -- this page will stop
              responding for a moment, then you can refresh it. You must also separately restart the
              Discord bot for it to see the restored data.
            </p>
          </div>
        ) : validation ? (
          <div className="space-y-3 text-sm">
            <p className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-red-300">
              This will overwrite ALL current bot data -- every alliance's Vault Trap/Capitol War
              history, member registrations, admin permissions, settings, everything -- with the
              contents of this backup. A safety backup of the current data is taken automatically
              first, so this can be undone by restoring that safety backup afterward if something's
              wrong.
            </p>
            <div>
              <div className="mb-1 text-slate-400">
                Files to restore ({validation.restoredNames.length}, {formatBytes(validation.totalSizeBytes)}):
              </div>
              <ul className="list-inside list-disc text-slate-300">
                {validation.restoredNames.map((n) => (
                  <li key={n} className="font-mono">{n}</li>
                ))}
              </ul>
            </div>
            {validation.missingFromZip.length > 0 && (
              <p className="text-xs text-slate-500">
                Not included in this backup (left as-is): {validation.missingFromZip.join(", ")}
              </p>
            )}
            <p className="text-amber-400">
              The web server and the Discord bot must both be restarted afterward to load the
              restored data -- neither happens automatically.
            </p>
            <label className="block">
              <span className="mb-1 block text-xs text-slate-400">
                Type {CONFIRM_PHRASE} to confirm
              </span>
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={CONFIRM_PHRASE}
                className="w-full max-w-xs rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100"
              />
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => confirmMutation.mutate()}
                disabled={confirmText !== CONFIRM_PHRASE || confirmMutation.isPending}
                className={buttonDanger}
              >
                {confirmMutation.isPending ? "Restoring…" : "Confirm restore"}
              </button>
              <button
                onClick={() => cancelMutation.mutate()}
                disabled={cancelMutation.isPending}
                className={buttonSecondary}
              >
                Cancel
              </button>
            </div>
            {confirmMutation.isError && (
              <p className="text-red-400">{(confirmMutation.error as Error).message}</p>
            )}
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <p className="text-slate-400">
              Upload a backup .zip to check it before anything is touched -- nothing under db/ changes
              until you confirm on the next screen.
            </p>
            <div>
              <label className="mb-1 block text-xs text-slate-400">Backup .zip</label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip"
                onChange={handleFileChange}
                disabled={validateMutation.isPending}
                className="block w-full text-sm text-slate-300"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-400">
                Password (only if this backup uses one)
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="mt-1 w-full max-w-xs rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                />
              </label>
              <p className="mt-1 text-xs text-slate-500">
                AES-encrypted backups (the Discord bot's password-protected export) aren't supported
                here -- use Discord's <code>/restore</code> command for those instead.
              </p>
            </div>
            {validateMutation.isPending && <LoadingState label="Validating…" />}
            {validateMutation.isError && (
              <p className="text-red-400">{(validateMutation.error as Error).message}</p>
            )}
          </div>
        )}
      </Card>
    </Layout>
  );
}
