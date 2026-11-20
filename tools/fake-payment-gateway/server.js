'use strict';
/**
 * The fake payment service as a small web server (Node 18+, no dependencies):
 *
 *   CONTROL_TOKEN=<a long random value> PORT=8080 node server.js
 *
 * CONTROL_TOKEN is required (there is no default: without one the control API refuses everyone). BASE_URL is the public address of the service
 * (https://fake-pay.example.org); when it is not set the address of each checkout is taken from the request that makes it (X-Forwarded-Proto/Host).
 * NOTICE_ORIGINS lists the origins the service may send its notices to (Orbit staging's public address): nothing else is ever contacted.
 * DATA_FILE (optional) keeps the state in a file so a restart loses nothing. See README.md.
 */
const http = require('node:http');
const fs = require('node:fs');
const { createGateway } = require('./core');
const { parseOrigins, createNoticeSender } = require('./notice');

const PORT = Number(process.env.PORT) || 8080;
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || '';
const BASE_URL = (process.env.BASE_URL || '').replace(/\/+$/, '');
const DATA_FILE = process.env.DATA_FILE || '';
const NOTICE_ORIGINS = parseOrigins(process.env.NOTICE_ORIGINS);
const MAX_BODY = 64 * 1024;

if (!CONTROL_TOKEN || CONTROL_TOKEN.length < 16) {
  console.error('CONTROL_TOKEN is required and must be at least 16 characters (it protects the control API).');
  process.exit(1);
}

if (NOTICE_ORIGINS.length === 0) console.warn('NOTICE_ORIGINS is not set: no notice will be sent to Orbit (set it to the public address of Orbit staging, e.g. https://orbit.example.org).');

// A notice goes only to an origin listed in NOTICE_ORIGINS, redirects included: the notify address of a payment is written by whoever makes the payment
const send = createNoticeSender({ origins: NOTICE_ORIGINS });

// The state is one, shared by every request: taken from the file when there is one, and written back as it changes. The address of a checkout is
// not part of it: it is BASE_URL when that is set, else the address of the request that is being answered (see publicUrlOf)
const publicUrlOf = (req) => BASE_URL || `${String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()}://${String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`).split(',')[0].trim()}`;
const primary = createGateway({ publicUrl: BASE_URL || `http://localhost:${PORT}`, controlToken: CONTROL_TOKEN, send });
if (DATA_FILE && fs.existsSync(DATA_FILE)) {
  try {
    primary.restore(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch (error) {
    console.error('Could not read DATA_FILE, starting empty:', error.message);
  }
}
let saved = '';
function persist() {
  if (!DATA_FILE) return;
  try {
    const text = JSON.stringify(primary.snapshot());
    if (text === saved) return;
    fs.writeFileSync(`${DATA_FILE}.tmp`, text);
    fs.renameSync(`${DATA_FILE}.tmp`, DATA_FILE);
    saved = text;
  } catch (error) {
    console.error('Could not write DATA_FILE:', error.message);
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) tooBig = true;
      else chunks.push(chunk);
    });
    req.on('end', () => resolve({ tooBig, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => resolve({ tooBig: false, text: '' }));
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const { tooBig, text } = await readBody(req);
    if (tooBig) {
      res.writeHead(413, { 'content-type': 'application/json' }).end('{"error":"Too large"}');
      return;
    }
    let parsed;
    if (text) {
      const type = String(req.headers['content-type'] || '');
      try {
        parsed = type.includes('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(text)) : JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    const answer = primary.handle({ method: req.method || 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, json: parsed, publicUrl: publicUrlOf(req) });
    persist();
    if (answer.drop) {
      req.socket.destroy();
      return;
    }
    if (answer.hang) {
      // A service that does not answer: hold the line until the caller gives up (or the time is out)
      const timer = setTimeout(() => res.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body || {})), answer.hang);
      req.on('close', () => clearTimeout(timer));
      return;
    }
    if (answer.redirect) {
      res.writeHead(answer.status || 303, { location: answer.redirect }).end();
      return;
    }
    if (answer.html !== undefined) {
      res.writeHead(answer.status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(answer.html);
      return;
    }
    if (answer.raw !== undefined) {
      res.writeHead(answer.status, { 'content-type': answer.type || 'text/plain' }).end(answer.raw);
      return;
    }
    res.writeHead(answer.status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(answer.body ?? {}));
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"Internal error"}');
  }
});

// What is due by the clock (a late capture) and the notices that are owed
setInterval(async () => {
  try {
    await primary.tick();
    persist();
  } catch (error) {
    console.error('tick failed:', error.message);
  }
}, 1000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`fake payment service on :${PORT}`));
}
module.exports = { server };
