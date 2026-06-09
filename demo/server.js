'use strict';
// A small instrumented service. Three instances run with different
// SERVICE_NAME / behaviour to simulate a real stack:
//   api  -> calls payments -> calls worker
// Each emits structured JSON logs, Prometheus metrics, and OTLP traces.
const express = require('express');
const client = require('prom-client');
const otel = require('@opentelemetry/api');

const SERVICE = process.env.SERVICE_NAME || 'demo';
const PORT = parseInt(process.env.PORT || '9100', 10);
const ERROR_RATE = parseFloat(process.env.ERROR_RATE || '0.04');
const BASE_LATENCY = parseInt(process.env.BASE_LATENCY_MS || '40', 10);
const CRASH_MEAN_MIN = parseFloat(process.env.CRASH_MEAN_MIN || '0'); // 0 = never crash

// topology: who this service calls downstream
const PEERS = {
  api: [{ name: 'payments', url: 'http://payments:9100/charge' }],
  payments: [{ name: 'worker', url: 'http://worker:9100/process' }],
  worker: [],
}[SERVICE] || [];

// ---------------------------------------------------------------- metrics
const register = client.register;
client.collectDefaultMetrics();
const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});
const httpTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'],
});
const httpErrors = new client.Counter({
  name: 'http_request_errors_total',
  help: 'Total HTTP requests that resulted in an error',
  labelNames: ['method', 'route'],
});

// ---------------------------------------------------------------- logging
function log(level, msg, extra) {
  const span = otel.trace.getActiveSpan();
  const traceId = span ? span.spanContext().traceId : undefined;
  const line = Object.assign(
    { ts: new Date().toISOString(), level, service: SERVICE, msg },
    traceId ? { trace_id: traceId } : {},
    extra || {}
  );
  process.stdout.write(JSON.stringify(line) + '\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function jitter(base) {
  // log-normal-ish: usually near base, occasional long tail
  const f = Math.random() < 0.92 ? 1 + Math.random() : 2 + Math.random() * 6;
  return Math.round(base * f);
}

// ---------------------------------------------------------------- app
const app = express();
app.use(express.json());

// metrics + access-log middleware
app.use((req, res, next) => {
  if (req.path === '/metrics' || req.path === '/health') return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const route = req.route ? req.route.path : req.path;
    const dur = Number(process.hrtime.bigint() - start) / 1e9;
    const labels = { method: req.method, route, status: String(res.statusCode) };
    httpDuration.observe(labels, dur);
    httpTotal.inc(labels);
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    if (res.statusCode >= 500) httpErrors.inc({ method: req.method, route });
    log(level, `${req.method} ${route} -> ${res.statusCode}`, {
      route,
      method: req.method,
      status: res.statusCode,
      duration_ms: Math.round(dur * 1000),
    });
  });
  next();
});

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});
app.get('/health', (_req, res) => res.json({ ok: true, service: SERVICE }));

async function callPeers() {
  for (const peer of PEERS) {
    try {
      const r = await fetch(peer.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: SERVICE, ts: Date.now() }),
      });
      if (!r.ok) log('warn', `downstream ${peer.name} returned ${r.status}`, { peer: peer.name, status: r.status });
    } catch (e) {
      log('error', `downstream ${peer.name} call failed: ${e.message}`, { peer: peer.name });
    }
  }
}

// the work handler shared by all business routes
async function handle(req, res) {
  await sleep(jitter(BASE_LATENCY));
  await callPeers();
  // inject failures
  if (Math.random() < ERROR_RATE) {
    const kinds = ['db timeout', 'upstream 502', 'null reference', 'connection reset', 'validation failed'];
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    await sleep(jitter(BASE_LATENCY)); // failures often slower
    return res.status(500).json({ error: kind, service: SERVICE });
  }
  res.json({ ok: true, service: SERVICE, ts: Date.now() });
}

app.get('/', handle);
app.post('/checkout', handle);
app.post('/charge', handle);
app.post('/process', handle);
app.post('/', handle);

app.listen(PORT, () => {
  log('info', `${SERVICE} listening on :${PORT}`, { port: PORT, error_rate: ERROR_RATE });
  startDriver();
  scheduleCrash();
});

// ---------------------------------------------------------------- load generator
// Each service drives its own traffic so every service has request metrics/logs.
// api additionally drives the cross-service chain via /checkout.
function startDriver() {
  const endpoints = {
    api: ['GET /', 'POST /checkout', 'POST /checkout'],
    payments: ['GET /'],
    worker: ['GET /'],
  }[SERVICE] || ['GET /'];

  let tick = 0;
  async function fire() {
    tick++;
    // sinusoidal base rate + occasional burst -> gives anomaly detection signal
    const phase = Math.sin(tick / 30) * 0.5 + 0.5; // 0..1
    const burst = Math.random() < 0.03 ? 5 : 1;
    const n = Math.max(1, Math.round((1 + phase * 4) * burst));
    for (let i = 0; i < n; i++) {
      const pick = endpoints[Math.floor(Math.random() * endpoints.length)];
      const [method, path] = pick.split(' ');
      fetch(`http://localhost:${PORT}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify({ self: true }),
      }).catch(() => {});
    }
    setTimeout(fire, 350 + Math.random() * 500);
  }
  setTimeout(fire, 1500 + Math.random() * 1500);
}

// ---------------------------------------------------------------- crash simulation
// Rare process crash -> Docker restarts the container -> backwork crash detection
// sees the fatal log + the restart. Off unless CRASH_MEAN_MIN > 0.
function scheduleCrash() {
  if (!(CRASH_MEAN_MIN > 0)) return;
  const meanMs = CRASH_MEAN_MIN * 60 * 1000;
  const delay = -Math.log(1 - Math.random()) * meanMs; // exponential
  setTimeout(() => {
    log('fatal', 'FATAL: container out of memory (OOM) — killing process', {
      signal: 'SIGKILL',
      reason: 'oom',
    });
    setTimeout(() => process.exit(137), 50);
  }, delay);
}
