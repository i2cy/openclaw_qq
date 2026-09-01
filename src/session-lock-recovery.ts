import { promises as fs } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

/**
 * Force-recover stale session write locks left behind by openclaw gateway
 * runs that were aborted mid-flight (abort settle timeout -> failover) and
 * never reached sessionLock.release().
 *
 * Safe-guards:
 *  - only locks whose pid+starttime match THIS gateway process are touched
 *    (never remove another gateway instance's lock)
 *  - only locks older than minAgeMs are removed (fresh locks may be legitimately held)
 *  - removing the file is enough: sidecar-lock acquire uses fs.open(lockPath, "wx"),
 *    so the next acquire creates a fresh lock and overwrites the stale in-process entry.
 */

const MIN_AGE_MS = 10_000;
const LOCK_SUFFIX = ".jsonl.lock";

function selfStarttime(): number | null {
    try {
        const stat = require("node:fs").readFileSync(`/proc/${process.pid}/stat`, "utf8");
        const commEndIndex = stat.lastIndexOf(")");
        if (commEndIndex < 0) return null;
        const fields = stat.slice(commEndIndex + 1).trimStart().split(/\s+/);
        const starttime = Number(fields[19]);
        return Number.isInteger(starttime) && starttime >= 0 ? starttime : null;
    } catch {
        return null;
    }
}

async function readLockPayload(lockPath: string): Promise<{ pid?: number; starttime?: number; createdAt?: string } | null> {
    try {
        return JSON.parse(await fs.readFile(lockPath, "utf8"));
    } catch {
        return null;
    }
}

async function isLockHeldByThisProcess(lockPath: string): Promise<boolean> {
    const payload = await readLockPayload(lockPath);
    if (!payload || typeof payload.pid !== "number" || payload.pid !== process.pid) return false;
    const starttime = selfStarttime();
    if (starttime === null) {
        // Cannot verify process identity; default to NOT touching the lock.
        return false;
    }
    if (typeof payload.starttime === "number" && payload.starttime !== starttime) {
        // PID was recycled by a different gateway process — not ours.
        return false;
    }
    return true;
}

async function lockAgeMs(lockPath: string): Promise<number | null> {
    try {
        const stat = await fs.stat(lockPath);
        return Math.max(0, Date.now() - stat.mtimeMs);
    } catch {
        return null;
    }
}

async function collectStaleSessionLocks(opts: { minAgeMs?: number } = {}): Promise<string[]> {
    const minAgeMs = opts.minAgeMs ?? MIN_AGE_MS;
    const home = homedir();
    if (!home) return [];
    const agentsDir = path.join(home, ".openclaw", "agents");
    const stale: string[] = [];
    let agents: string[] = [];
    try {
        agents = await fs.readdir(agentsDir, { withFileTypes: true }).then((entries) =>
            entries.filter((e) => e.isDirectory()).map((e) => e.name)
        );
    } catch {
        return [];
    }
    for (const agent of agents) {
        const sessionsDir = path.join(agentsDir, agent, "sessions");
        let files: string[] = [];
        try {
            files = await fs.readdir(sessionsDir);
        } catch {
            continue;
        }
        for (const file of files) {
            if (!file.endsWith(LOCK_SUFFIX)) continue;
            const lockPath = path.join(sessionsDir, file);
            if (!(await isLockHeldByThisProcess(lockPath))) continue;
            const age = await lockAgeMs(lockPath);
            if (age === null || age < minAgeMs) continue;
            stale.push(lockPath);
        }
    }
    return stale;
}

export async function recoverStaleSessionLocks(opts: { minAgeMs?: number } = {}): Promise<string[]> {
    const stale = await collectStaleSessionLocks(opts);
    const removed: string[] = [];
    for (const lockPath of stale) {
        try {
            await fs.rm(lockPath, { force: true });
            removed.push(lockPath);
        } catch (err) {
            console.warn(`[QQ] failed to remove stale session lock ${lockPath}: ${String(err)}`);
        }
    }
    if (removed.length > 0) {
        console.warn(
            `[QQ] force-recovered stale session write lock(s) (abort-timeout failover residue):\n  ${removed.join("\n  ")}`
        );
    }
    return removed;
}

export async function hasStaleSessionLock(sessionId?: string, opts: { minAgeMs?: number } = {}): Promise<boolean> {
    const stale = await collectStaleSessionLocks(opts);
    if (!sessionId) return stale.length > 0;
    return stale.some((p) => path.basename(p).startsWith(sessionId));
}
