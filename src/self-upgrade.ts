/** Self-upgrade trigger — kicks off the claudeclaw-update.service oneshot unit.
 * systemd owns the updater independently, so the restart it issues at the end
 * does not kill the bot process that triggered it. */

export interface UpgradeTriggerResult {
  ok: boolean;
  exitCode: number;
  stderr: string;
}

export async function triggerSelfUpgrade(): Promise<UpgradeTriggerResult> {
  const proc = Bun.spawn(
    ["systemctl", "--user", "start", "--no-block", "claudeclaw-update.service"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  const stderr = exitCode === 0 ? "" : await new Response(proc.stderr).text();
  return { ok: exitCode === 0, exitCode, stderr };
}
