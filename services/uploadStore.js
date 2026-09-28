const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pool = require('../config/db');

// Durable copies of uploaded photos (face-verification selfies, registered
// faces, employee photos, OCR scans), kept in MySQL under the same public
// path the app already stores ("/uploads/selfies/123.jpg").
//
// Render's free instance has no persistent disk: the uploads/ folder is
// wiped on every deploy and every restart (including waking up after 15
// idle minutes), which left the database pointing at photos that no longer
// existed. The file on disk is still written first and used as-is (face
// recognition reads it); this copy is what survives. serveStoredUpload
// answers /uploads/* requests for files the disk no longer has.
//
// Copies are downscaled JPEGs (longest side 800px), roughly 40-80 KB each,
// so the free database's storage goes a long way. Videos are not stored.

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const MAX_SIDE = 800;
const JPEG_QUALITY = 78;

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = pool.query(
      `CREATE TABLE IF NOT EXISTS stored_uploads (
         path VARCHAR(255) NOT NULL PRIMARY KEY,
         mime_type VARCHAR(50) NOT NULL,
         data MEDIUMBLOB NOT NULL,
         size_bytes INT NOT NULL,
         created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    ).catch((err) => {
      tableReady = null; // retry on the next call
      throw err;
    });
  }
  return tableReady;
}

// "/uploads/selfies/x.jpg" for an absolute file path inside uploads/, else null.
function publicPathFor(absPath) {
  const rel = path.relative(UPLOADS_DIR, absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return `/uploads/${rel.split(path.sep).join('/')}`;
}

async function compress(input) {
  return sharp(input)
    .rotate() // apply EXIF orientation before it's stripped
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
}

// Stores `input` (file path or Buffer) under `publicPath`. Replaces any
// existing copy for that path.
async function saveUpload(publicPath, input) {
  await ensureTable();
  const data = await compress(input);
  await pool.query(
    `INSERT INTO stored_uploads (path, mime_type, data, size_bytes) VALUES (?, 'image/jpeg', ?, ?)
     ON DUPLICATE KEY UPDATE mime_type = VALUES(mime_type), data = VALUES(data), size_bytes = VALUES(size_bytes)`,
    [publicPath, data, data.length]
  );
  return data.length;
}

async function hasUpload(publicPath) {
  await ensureTable();
  const [rows] = await pool.query('SELECT 1 FROM stored_uploads WHERE path = ?', [publicPath]);
  return rows.length > 0;
}

// Express middleware, run right after multer: stores a copy of every
// uploaded IMAGE in the request. A failure is logged, not thrown -- the
// request itself (e.g. the attendance face check) must not fail because of it.
async function persistRequestUploads(req, res, next) {
  const files = [];
  if (req.file) files.push(req.file);
  if (req.files) files.push(...(Array.isArray(req.files) ? req.files : Object.values(req.files).flat()));
  for (const file of files) {
    if (!file.path || !/^image\//.test(file.mimetype || '')) continue;
    const publicPath = publicPathFor(file.path);
    if (!publicPath) continue;
    try {
      await saveUpload(publicPath, file.path);
    } catch (err) {
      console.error(`[uploadStore] Could not store ${publicPath}:`, err.message);
    }
  }
  next();
}

// Express middleware for GET /uploads/*, mounted after express.static: the
// file isn't on disk (wiped by a restart), so serve the stored copy and put
// it back on disk for next time.
async function serveStoredUpload(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  let publicPath;
  try {
    publicPath = `/uploads${decodeURIComponent(req.path)}`;
  } catch (e) {
    return next();
  }
  if (publicPath.includes('..')) return next();
  try {
    await ensureTable();
    const [rows] = await pool.query('SELECT mime_type, data FROM stored_uploads WHERE path = ?', [publicPath]);
    if (!rows[0]) return next();
    const { mime_type: mimeType, data } = rows[0];
    if (!wasDeletedLocally(publicPath)) {
      const diskPath = diskPathFor(publicPath);
      fs.promises.mkdir(path.dirname(diskPath), { recursive: true })
        .then(() => fs.promises.writeFile(diskPath, data))
        .then(() => { loadKnownPaths().add(publicPath); return saveKnownPaths(); })
        .catch(() => {});
    }
    res.set('Content-Type', mimeType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(data);
  } catch (err) {
    next(err);
  }
}

// Deletes a photo for good: its stored copy and the file on this machine's
// disk. With the stored copy gone, no server's sync can write it back.
async function removeUpload(publicPath) {
  if (!publicPath || !publicPath.startsWith('/uploads/') || publicPath.includes('..')) return;
  await ensureTable();
  await pool.query('DELETE FROM stored_uploads WHERE path = ?', [publicPath]);
  await fs.promises.unlink(diskPathFor(publicPath)).catch(() => {});
}

function diskPathFor(publicPath) {
  return path.join(UPLOADS_DIR, ...publicPath.slice('/uploads/'.length).split('/'));
}

// Every photo path this machine has already had on disk, saved in
// uploads/.sync-state.json. A known path that's now missing was deleted on
// purpose, so the sync (and serveStoredUpload) leave it deleted instead of
// writing it back on every run. A wiped folder (Render restart) loses this
// file too, so there everything is still restored as before.
const STATE_FILE = path.join(UPLOADS_DIR, '.sync-state.json');
let knownPaths = null;
let hadStateFile = false;
function loadKnownPaths() {
  if (!knownPaths) {
    try {
      knownPaths = new Set(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
      hadStateFile = true;
    } catch (e) {
      knownPaths = new Set();
    }
  }
  return knownPaths;
}
// Any photo in uploads/ at all (not just the .gitkeep placeholders)?
function hasAnyPhotoOnDisk() {
  try {
    return fs.readdirSync(UPLOADS_DIR, { withFileTypes: true }).some((dir) =>
      dir.isDirectory() &&
      fs.readdirSync(path.join(UPLOADS_DIR, dir.name)).some((name) => !name.startsWith('.')));
  } catch (e) {
    return false;
  }
}
async function saveKnownPaths() {
  await fs.promises.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.promises.writeFile(STATE_FILE, JSON.stringify([...loadKnownPaths()]));
}
// True when this machine had the file and it has since been deleted.
function wasDeletedLocally(publicPath) {
  return loadKnownPaths().has(publicPath) && !fs.existsSync(diskPathFor(publicPath));
}

// Writes stored photos that aren't on this machine's disk yet into uploads/
// (same subfolder and filename as their path). Local and deployed servers
// share one database, so a server running on localhost gets every photo
// captured anywhere -- mobile face verification (including anomaly checks),
// OCR scans, kiosk face checks, registrations -- in its own uploads folder,
// and a freshly restarted host gets its wiped folder back. Photos deleted
// from this machine's uploads/ stay deleted (see wasDeletedLocally).
//
// The first run checks everything; later runs only look at rows added since
// the previous run (plus a minute of overlap), which keeps a 5-second
// interval cheap. Returns how many files were written.
let syncing = false;
let syncedUpTo = null; // newest created_at seen, as the DB returned it
async function syncToDisk({ full = false } = {}) {
  if (syncing) return 0;
  syncing = true;
  let written = 0;
  const known = loadKnownPaths();
  const knownBefore = known.size;
  // First run without a state file (e.g. just upgraded) in a folder that
  // still has photos: it wasn't wiped, so anything missing was deleted on
  // purpose. An empty folder (fresh clone, wiped host) is restored in full.
  const adoptMissing = full && !hadStateFile && knownBefore === 0 && hasAnyPhotoOnDisk();
  try {
    await ensureTable();
    const since = full ? null : syncedUpTo;
    const [rows] = since
      // One minute of overlap covers a row committed a little after its
      // created_at; files already on disk are skipped straight away.
      ? await pool.query('SELECT path, created_at FROM stored_uploads WHERE created_at >= ? - INTERVAL 1 MINUTE ORDER BY created_at', [since])
      : await pool.query('SELECT path, created_at FROM stored_uploads ORDER BY created_at');
    for (const { path: publicPath, created_at: createdAt } of rows) {
      syncedUpTo = createdAt;
      if (!publicPath.startsWith('/uploads/') || publicPath.includes('..')) continue;
      const diskPath = diskPathFor(publicPath);
      if (fs.existsSync(diskPath)) {
        known.add(publicPath);
        continue;
      }
      if (adoptMissing) known.add(publicPath);
      if (known.has(publicPath)) continue; // deleted on purpose -- leave it
      const [[row]] = await pool.query('SELECT data FROM stored_uploads WHERE path = ?', [publicPath]);
      if (!row) continue;
      await fs.promises.mkdir(path.dirname(diskPath), { recursive: true });
      await fs.promises.writeFile(diskPath, row.data);
      known.add(publicPath);
      written++;
    }
    if (known.size !== knownBefore) await saveKnownPaths();
  } finally {
    syncing = false;
  }
  return written;
}

// Full sync now, then new photos every intervalMs (default 5 s) so a photo
// captured on any server shows up in this machine's uploads/ within seconds.
function startDiskSync(intervalMs = Number(process.env.UPLOAD_SYNC_INTERVAL_MS) || 5000) {
  const tick = (full) => syncToDisk({ full })
    .then((n) => { if (n) console.log(`[uploadStore] Saved ${n} photo(s) into uploads/.`); })
    .catch((err) => console.error('[uploadStore] Sync to uploads/ failed:', err.message));
  tick(true);
  return setInterval(() => tick(false), intervalMs);
}

module.exports = { saveUpload, hasUpload, removeUpload, persistRequestUploads, serveStoredUpload, publicPathFor, ensureTable, syncToDisk, startDiskSync };
