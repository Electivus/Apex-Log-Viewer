'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

function contains(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function defaultDirectory() {
  // Packaged Windows hosts can virtualize LocalAppData into their LocalCache.
  // Keep the operator's only key outside application-managed storage.
  return path.join(os.homedir(), '.electivus', 'apex-log-viewer', 'devhub-jwt');
}

// Validate both the lexical path and every existing ancestor before creating or
// securing anything. A junction must not redirect private writes or ACL changes.
async function durablePath(input, { create = false } = {}) {
  const target = path.resolve(input || defaultDirectory());
  const forbidden = [
    os.tmpdir(),
    process.env.TEMP,
    process.env.TMP,
    process.env.OneDrive,
    process.env.OneDriveConsumer,
    process.env.OneDriveCommercial
  ].filter(Boolean);
  if (
    !contains(os.homedir(), target) ||
    forbidden.some(root => contains(path.resolve(root), target)) ||
    target
      .split(/[\\/]/)
      .some(part => /^(?:temp|tmp|localcache|\.?caches?|onedrive(?:.*)|dropbox|google drive|iclouddrive)$/i.test(part))
  ) {
    throw new Error(
      'Operator state requires durable per-user storage outside temporary, cache and synchronized folders.'
    );
  }
  for (let ancestor = target; ; ancestor = path.dirname(ancestor)) {
    try {
      if ((await fs.lstat(ancestor)).isSymbolicLink())
        throw new Error('Operator state cannot traverse links or junctions.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      await fs.lstat(path.join(ancestor, '.git'));
      throw new Error('Operator state requires durable storage outside every Git checkout.');
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
    if (path.dirname(ancestor) === ancestor) break;
  }
  if (create) await fs.mkdir(target, { recursive: true, mode: 0o700 });
  try {
    const real = await fs.realpath(target);
    if (real.toLowerCase() !== target.toLowerCase())
      throw new Error('Durable operator storage was redirected; select an unredirected per-user directory.');
    return real;
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new Error(
        'Durable operator state is missing. Restore a verified backup or prepare lost-material recovery.'
      );
    throw error;
  }
}

async function privateFile(directory, file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !contains(directory, file) || directory === file)
    throw new Error('Operator input references must stay inside their durable state directory.');
  const real = await durablePath(file);
  const info = await fs.stat(real);
  if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0))
    throw new Error('Operator inputs must be private regular files.');
  return real;
}

module.exports = { durablePath, privateFile, defaultDirectory };
