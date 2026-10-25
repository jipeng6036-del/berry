'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const root = __dirname;
async function main() {
  const label = process.argv[2];
  const mode = process.argv[4] || 'basic';
  const expectedProxyAuthorization = 'Basic ' + Buffer.from('proxy@example:a:b+ c%').toString('base64');
  const bundle = path.resolve(process.argv[3]);
  const work = path.join(root, `runtime-${label}`);
  await fs.mkdir(work, {recursive: true});
  const tarball = await fs.readFile(path.join(root, 'package.tgz'));
  const requests = [], proxyRequests = [], sockets = new Set();
  let registryPort;
  const registry = http.createServer((req, res) => {
    requests.push({method: req.method, url: req.url, headers: req.headers});
    if (mode === 'auth-redirect' && req.url === '/forward-proxy-fixture') {res.writeHead(302, {location: `http://localhost:${registryPort}/metadata/forward-proxy-fixture`});res.end();return;}
    if (req.url.startsWith('/tarball/')) {res.setHeader('content-type', 'application/octet-stream');res.end(tarball);return;}
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({name: 'forward-proxy-fixture', time: {'1.0.0': '2020-01-01T00:00:00Z'}, 'dist-tags': {latest: '1.0.0'}, versions: {'1.0.0': {name: 'forward-proxy-fixture', version: '1.0.0', dist: {tarball: `http://127.0.0.1:${registryPort}/tarball/package.tgz`, shasum: crypto.createHash('sha1').update(tarball).digest('hex')}}}}));
  });
  const proxy = http.createServer((req, res) => {
    proxyRequests.push({method: req.method, url: req.url, headers: req.headers});
    if (mode === 'auth-redirect' && req.headers['proxy-authorization'] !== expectedProxyAuthorization) {res.writeHead(407);res.end('synthetic proxy credentials required');return;}
    let url;
    try {url = new URL(req.url);} catch {res.writeHead(400);res.end('absolute URL required');return;}
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || Number(url.port) !== registryPort) {res.writeHead(403);res.end('local fixture only');return;}
    const headers = {...req.headers};delete headers['proxy-authorization'];delete headers['proxy-connection'];
    const upstream = http.request({hostname: '127.0.0.1', port: registryPort, path: url.pathname + url.search, method: req.method, headers}, upstreamRes => {res.writeHead(upstreamRes.statusCode, upstreamRes.headers);upstreamRes.pipe(res);});
    upstream.on('error', error => {res.writeHead(502);res.end(error.message);});req.pipe(upstream);
  });
  proxy.on('connect', (req, socket) => {proxyRequests.push({method: req.method, url: req.url, headers: req.headers});socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');});
  for (const server of [registry, proxy]) server.on('connection', socket => {sockets.add(socket);socket.on('close', () => sockets.delete(socket));});
  const receipt = {label, mode, command: [process.execPath, __filename, ...process.argv.slice(2)], harnessSha256: crypto.createHash('sha256').update(await fs.readFile(__filename)).digest('hex'), bundle, bundleSha256: crypto.createHash('sha256').update(await fs.readFile(bundle)).digest('hex'), node: process.version, parentPid: process.pid, packageSha256: crypto.createHash('sha256').update(tarball).digest('hex')};
  try {
    registry.listen(0, '127.0.0.1');await once(registry, 'listening');registryPort = registry.address().port;
    proxy.listen(0, '127.0.0.1');await once(proxy, 'listening');receipt.registryPort = registryPort;receipt.proxyPort = proxy.address().port;
    const project = path.join(work, 'project');await fs.mkdir(project, {recursive: true});
    await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({name: 'local-forward-proof', private: true, dependencies: {'forward-proxy-fixture': '1.0.0'}}));
    await fs.writeFile(path.join(project, '.yarnrc.yml'), `npmRegistryServer: "http://127.0.0.1:${registryPort}"\nhttpProxy: "http://${mode === 'auth-redirect' ? 'proxy%40example:a%3Ab%2B%20c%25@' : ''}127.0.0.1:${proxy.address().port}"\nunsafeHttpWhitelist: [127.0.0.1]\nnodeLinker: node-modules\nenableGlobalCache: false\nenableTelemetry: false\nenableScripts: false\nhttpRetry: 0\nhttpTimeout: 3000\n`);
    const child = spawn(process.execPath, [bundle, 'install', '--json'], {cwd: project, env: {...process.env, YARN_IGNORE_PATH: '1', YARN_ENABLE_IMMUTABLE_INSTALLS: 'false', YARN_ENABLE_TELEMETRY: 'false', YARN_GLOBAL_FOLDER: path.join(work, 'global'), NODE_OPTIONS: ''}, windowsHide: true});
    receipt.childPid = child.pid;let stdout = '', stderr = '';child.stdout.on('data', b => stdout += b);child.stderr.on('data', b => stderr += b);
    const timer = setTimeout(() => child.kill(), 15000);const [exitCode, signal] = await once(child, 'exit');clearTimeout(timer);
    receipt.exitCode = exitCode;receipt.signal = signal;receipt.stdout = stdout;receipt.stderr = stderr;
    if (exitCode === 0) {const probe = spawn(process.execPath, ['-p', 'JSON.stringify(require("forward-proxy-fixture"))'], {cwd: project, windowsHide: true});let output='';probe.stdout.on('data', b=>output+=b);receipt.probeExit = (await once(probe, 'exit'))[0];receipt.probeOutput=output.trim();}
    receipt.registryRequests = requests;receipt.proxyRequests = proxyRequests;
    receipt.proxyCredentialsWereForwarded = requests.some(r => r.headers['proxy-authorization']);
    receipt.proxyAuthenticationMatched = mode !== 'auth-redirect' || proxyRequests.every(r => r.headers['proxy-authorization'] === expectedProxyAuthorization);
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([registry, proxy].map(server => new Promise(resolve => server.close(resolve))));
    receipt.serversClosed = true;await fs.writeFile(path.join(root, `${label}-runtime.json`), JSON.stringify(receipt, null, 2));
  }
  receipt.expectedBehaviorVerified = label.startsWith('baseline') ? receipt.exitCode === 1 && receipt.proxyRequests.some(r => r.method === 'CONNECT') && receipt.registryRequests.length === 0 : receipt.exitCode === 0 && receipt.probeExit === 0 && receipt.registryRequests.some(r => r.url === '/tarball/package.tgz') && receipt.proxyRequests.every(r => r.method !== 'CONNECT');
  await fs.writeFile(path.join(root, `${label}-runtime.json`), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({label, exitCode: receipt.exitCode, probe: receipt.probeOutput, proxyMethods: receipt.proxyRequests.map(r => r.method), registryPaths: receipt.registryRequests.map(r => r.url), bundleSha256: receipt.bundleSha256, packageSha256: receipt.packageSha256, serversClosed: receipt.serversClosed}, null, 2));
  if ((label.startsWith('baseline') ? receipt.exitCode === 0 : receipt.exitCode !== 0) || (!label.startsWith('baseline') && receipt.probeExit !== 0) || receipt.proxyCredentialsWereForwarded || !receipt.proxyAuthenticationMatched || !receipt.expectedBehaviorVerified) throw new Error('Unexpected real CLI result; see receipt');
}
main().catch(error => {console.error(error);process.exitCode=1;});
