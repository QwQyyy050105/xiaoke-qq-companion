import { open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** Publish a fully flushed sibling file. Callers retain their own ordering queues.
 * File sync reduces interrupted-write loss; filesystem/hardware failure and rename
 * metadata durability still depend on the operating system and storage device. */
export async function durableWriteFile(target, contents, { io = { open, rename, unlink } } = {}) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('durable_write_absolute_path_required');
  const temporary = path.join(path.dirname(target), `${path.basename(target)}.${randomUUID()}.tmp`);
  let handle;
  let ownsTemporary = false;
  try {
    handle = await io.open(temporary, 'wx', 0o600);
    ownsTemporary = true;
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await io.rename(temporary, target);
    ownsTemporary = false;
  } finally {
    try { await handle?.close(); }
    finally {
      if (ownsTemporary) await io.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}
