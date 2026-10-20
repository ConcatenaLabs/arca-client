'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The only surface the window sees: no Node, no file system, no process. Every
// wallet command goes through the main process, which checks its arguments
// and runs the bundled arca client.
contextBridge.exposeInMainWorld('arca', {
  state: () => ipcRenderer.invoke('state'),
  run: (command, args) => ipcRenderer.invoke('arca', command, args || {}),
  syncNow: () => ipcRenderer.invoke('sync-now'),
  setAutoSync: (on) => ipcRenderer.invoke('set-auto-sync', on),
  setNode: (node) => ipcRenderer.invoke('set-node', node),
  setOperator: (op) => ipcRenderer.invoke('set-operator', op),
  testNode: (node) => ipcRenderer.invoke('test-node', node),
  assetLabels: () => ipcRenderer.invoke('asset-labels'),
  join: (j) => ipcRenderer.invoke('join', j || {}),
  mnemonic: () => ipcRenderer.invoke('mnemonic'),
  setBackedUp: () => ipcRenderer.invoke('set-backed-up'),
  setMode: (m) => ipcRenderer.invoke('set-mode', m),
  copy: (text) => ipcRenderer.invoke('copy', text),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  logs: () => ipcRenderer.invoke('logs'),
  onSyncEvent: (fn) => ipcRenderer.on('sync-event', (_e, ev) => fn(ev)),
  onLog: (fn) => ipcRenderer.on('log', (_e, l) => fn(l)),
});
