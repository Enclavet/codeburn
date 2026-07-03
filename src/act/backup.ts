import { copyFile, lstat, mkdir, readFile, rename, rm } from 'fs/promises'
import { createHash } from 'crypto'
import { dirname, join } from 'path'
import type { FileChange } from './types.js'

export function backupDirFor(actionsDir: string, id: string): string {
  return join(actionsDir, 'backups', id)
}

export function relBackupPath(id: string, index: number): string {
  return `backups/${id}/${index}.bak`
}

// Copy src to dest if src exists; return whether it existed so the caller can
// record backup: null for a create.
export async function snapshotFile(src: string, dest: string): Promise<boolean> {
  try {
    await copyFile(src, dest)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

export async function sha256File(path: string): Promise<string | null> {
  try {
    return sha256(await readFile(path))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

// Reverse a single applied change. Shared by mid-apply rollback and undo.
// Non-move reverts key on backup presence, not the op label, so a create that
// overwrote an existing file and an edit of a missing file restore correctly.
export async function revertChange(actionsDir: string, change: FileChange): Promise<void> {
  const restore = async (backup: string, to: string): Promise<void> => {
    await mkdir(dirname(to), { recursive: true })
    await copyFile(join(actionsDir, backup), to)
  }
  if (change.op === 'move') {
    if (await pathExists(change.movedTo!)) {
      await rm(change.path, { recursive: true, force: true })
      await mkdir(dirname(change.path), { recursive: true })
      await rename(change.movedTo!, change.path)
      if (change.destBackup) await restore(change.destBackup, change.movedTo!)
    } else if (change.backup) {
      // The moved file is gone; fall back to the source snapshot.
      await restore(change.backup, change.path)
    }
    return
  }
  if (change.backup) await restore(change.backup, change.path)
  else await rm(change.path, { recursive: true, force: true })
}
