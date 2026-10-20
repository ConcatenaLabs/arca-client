'use strict';
// Run under Electron's own Node (ELECTRON_RUN_AS_NODE=1), which holds files
// without close-on-exec as the app does: runs the stand-in arca once and
// prints what each of its descriptors points to. With "direct" it is spawned
// plainly; otherwise through the manager.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ArcaRunner } = require('../../src/main/arca');

const fake = path.join(__dirname, 'fake-arca.js');
if (process.argv[2] === 'notes') {
  // What the stand-in wrote on its standard error, as the manager hands it on.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-fds-'));
  new ArcaRunner({ bin: fake, datadir: dir }).run(['note']).then(({ notes }) => {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(JSON.stringify(notes));
  });
} else if (process.argv[2] === 'direct') {
  const r = spawnSync(fake, ['fds'], { encoding: 'utf8' });
  console.log(JSON.stringify(JSON.parse(r.stdout).fds));
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-fds-'));
  new ArcaRunner({ bin: fake, datadir: dir }).run(['fds']).then(({ result }) => {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(JSON.stringify(result.fds));
  });
}
