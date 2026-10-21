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
  // The Bitcoin side: Bark's wallet for Bitcoin arks, made from this wallet's
  // mnemonic, run through the arca client on a queue of its own.
  btc: (command, args) => ipcRenderer.invoke('btc', command, args || {}),
  btcSummary: () => ipcRenderer.invoke('btc-summary'),
  btcReceive: (args) => ipcRenderer.invoke('btc-receive', args || {}),
  btcClaim: (args) => ipcRenderer.invoke('btc-claim', args || {}),
  btcClaimStop: () => ipcRenderer.invoke('btc-claim-stop'),
  onBtcEvent: (fn) => ipcRenderer.on('btc-event', (_e, ev) => fn(ev)),
  // The swap of BTC for an asset with another wallet of the operator; the
  // main process follows each swap under way on its own.
  swap: (command, args) => ipcRenderer.invoke('swap', command, args || {}),
  swapStatus: () => ipcRenderer.invoke('swap-status'),
  onSwapEvent: (fn) => ipcRenderer.on('swap-event', (_e, ev) => fn(ev)),
});
