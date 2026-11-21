import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OwnerFailure } from './errors.mjs';

const execFileAsync = promisify(execFile);
let darwinBootId;

async function getDarwinBootId() {
  if (darwinBootId) return darwinBootId;
  const { stdout } = await execFileAsync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], {
    encoding: 'utf8',
    timeout: 3000,
  });
  const match = stdout.match(/sec\s*=\s*(\d+)/);
  if (!match) throw new Error('INVALID_PROCESS_IDENTITY');
  return (darwinBootId = `darwin-boot-${match[1]}`);
}

export function parseDarwinProcessIdentity(stdout, boot, pid) {
  const line = stdout.trim();
  if (!line) return null;
  const match = line.match(/^(\S+)\s+(.+)$/);
  if (!match || !boot) throw new Error('INVALID_PROCESS_IDENTITY');
  return { pid, start: match[2].trim(), boot, state: match[1] };
}

export async function processIdentity(pid = process.pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new OwnerFailure('PROCESS_IDENTITY_UNAVAILABLE');
  if (process.platform === 'linux') {
    try {
      let stat;
      try {
        stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
      } catch (error) {
        // Linux can open stat while the task exists, then return ESRCH from
        // read after it exits. Only errors from this PID's stat prove absence.
        if (['ENOENT', 'ESRCH'].includes(error.code)) return null;
        throw error;
      }
      const boot = await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (!/^\d+$/.test(fields[19] ?? '') || !fields[0] || !boot.trim())
        throw new Error('INVALID_PROCESS_IDENTITY');
      return { pid, start: fields[19], boot: boot.trim(), state: fields[0] };
    } catch (cause) {
      throw new OwnerFailure('PROCESS_IDENTITY_UNAVAILABLE', false, { cause });
    }
  }
  if (process.platform === 'darwin') {
    try {
      const boot = await getDarwinBootId();
      try {
        const { stdout } = await execFileAsync(
          '/bin/ps',
          ['-o', 'state=,lstart=', '-p', String(pid)],
          {
            encoding: 'utf8',
            env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
            timeout: 3000,
          },
        );
        return parseDarwinProcessIdentity(stdout, boot, pid);
      } catch (error) {
        if (error.code === 1 && !error.killed) return null;
        throw error;
      }
    } catch (cause) {
      throw new OwnerFailure('PROCESS_IDENTITY_UNAVAILABLE', false, { cause });
    }
  }
  throw new OwnerFailure('PROCESS_IDENTITY_UNAVAILABLE');
}
export const sameOwner = (a, b) =>
  Boolean(a && b && a.pid === b.pid && a.start === b.start && a.boot === b.boot);

export async function ownerAlive(owner) {
  if (owner === null) return false;
  const current = await processIdentity(owner.pid);
  return sameOwner(current, owner) && !['Z', 'X'].includes(current.state?.[0]);
}
