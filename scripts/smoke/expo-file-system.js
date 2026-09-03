/** Minimal expo-file-system v3 API used by workoutStore's dev photo store:
 * Directory/File/Paths with create/copy/exists/uri semantics. Photos are
 * stored under the harness prefix so they're per-test. */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { randomUUID } = require('crypto');

const ROOT = path.join(os.tmpdir(), 'spotter-smoke');
function ensure(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function clean(prefix) {
  const base = path.join(ROOT, prefix);
  fs.rmSync(base, { recursive: true, force: true });
}
class Directory {
  constructor(...parts) {
    this._p = path.join(...parts);
  }
  get exists() {
    return fs.existsSync(this._p);
  }
  get uri() {
    return 'file://' + this._p;
  }
  create() {
    ensure(this._p);
    return this;
  }
  createFile(name, mime) {
    const file = new File(path.join(this._p, name), mime);
    ensure(path.dirname(file._p));
    return file;
  }
}
class FileStream {
  constructor(file) {
    this._file = file;
  }
  writeAsStringAsync(content) {
    fs.writeFileSync(this._file._p, content, 'utf8');
    return Promise.resolve();
  }
}
class File {
  constructor(uriOrPath, mime) {
    this._p = String(uriOrPath).replace(/^file:\/\//, '');
    this._mime = mime ?? '';
  }
  static streams() {
    return { createNewStream: (file) => new FileStream(file) };
  }
  get exists() {
    return fs.existsSync(this._p);
  }
  get uri() {
    return 'file://' + this._p;
  }
  get type() {
    return this._mime;
  }
  copy(dest, opts) {
    ensure(path.dirname(dest._p));
    fs.copyFileSync(this._p, dest._p);
    if (opts?.overwrite === undefined) {
      fs.copyFileSync(this._p, dest._p + '.bak');
      fs.rmSync(dest._p + '.bak', { force: true });
    }
    return Promise.resolve();
  }
}
const Paths = {
  cache: path.join(ROOT, 'cache'),
  document: path.join(ROOT, 'docs'),
};
/** Harness helper: write a fake captured-photo file at a path. */
function _ensureFile(file) {
  ensure(path.dirname(file._p));
  fs.writeFileSync(file._p, 'fake-jpeg-bytes', 'utf8');
}
module.exports = { Directory, File, Paths, _clean: clean, _root: ROOT, _ensureFile };