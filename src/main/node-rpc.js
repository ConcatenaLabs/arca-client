'use strict';
// Plain JSON-RPC over HTTP to Sequentia Core, for the settings' "Test the
// node" and the assets' names. The wallet reads the chain itself, through the
// same node, and refuses one that does not keep a transaction index or does
// not validate its Bitcoin anchors; the test says so before a wallet is made.
const http = require('http');
const https = require('https');
const fs = require('fs');

function auth(node) {
  if (node.cookie) {
    try { return fs.readFileSync(node.cookie, 'utf8').trim(); } catch (e) { throw new Error(`the cookie file cannot be read: ${e.message}`, { cause: e }); }
  }
  return node.user ? `${node.user}:${node.password || ''}` : undefined;
}

function nodeRpc(node, method, params = []) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(node.url); } catch { return reject(new Error(`the node's address ${JSON.stringify(node.url)} is not a URL`)); }
    let a;
    try { a = auth(node); } catch (e) { return reject(e); }
    const body = JSON.stringify({ jsonrpc: '1.0', id: 'arca-client', method, params });
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname || '/', method: 'POST', timeout: 10000, auth: a,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('the node refused the credentials (HTTP 401)'));
        try {
          const j = JSON.parse(data);
          if (j.error) return reject(new Error(j.error.message || JSON.stringify(j.error)));
          resolve(j.result);
        } catch { reject(new Error(`the node answered HTTP ${res.statusCode} without JSON-RPC`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('the node did not answer within 10 s')));
    req.on('error', (e) => reject(new Error(e.message)));
    req.end(body);
  });
}

// What the wallet needs of its node, each found or not.
async function checkNode(node) {
  const info = await nodeRpc(node, 'getblockchaininfo');
  const out = { chain: info.chain, blocks: info.blocks, headers: info.headers, ibd: !!info.initialblockdownload, txindex: null, anchors: null };
  try { const ix = await nodeRpc(node, 'getindexinfo'); out.txindex = !!(ix && ix.txindex); } catch { out.txindex = null; }
  try { const a = await nodeRpc(node, 'getanchorstatus'); out.anchors = a; } catch (e) { out.anchors = { error: e.message }; }
  return out;
}

module.exports = { nodeRpc, checkNode };
