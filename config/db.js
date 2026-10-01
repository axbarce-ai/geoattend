const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

// Managed MySQL hosts (Aiven's free tier among them) require an SSL/TLS
// connection and give you a CA certificate to download -- point DB_SSL_CA
// at that file's path and the connection is verified against it. A plain
// local MySQL (the default) needs neither variable set. DB_SSL=true without
// a CA file trusts Node's built-in CA list instead, for a host whose
// certificate chains to a public CA rather than issuing its own.
//
// config/aiven-ca.pem is this project's Aiven CA certificate, committed on
// purpose (it's public -- it only proves the server is the real Aiven host,
// it grants no access). It's the fallback when DB_SSL_CA points at a path
// that doesn't exist, e.g. a Render Secret File that was never added.
const BUNDLED_CA = path.join(__dirname, 'aiven-ca.pem');

function buildSslConfig() {
  if (process.env.DB_SSL_CA) {
    let caPath = process.env.DB_SSL_CA;
    if (!fs.existsSync(caPath) && fs.existsSync(BUNDLED_CA)) {
      console.warn(`DB_SSL_CA file not found at ${caPath}; using bundled ${BUNDLED_CA}`);
      caPath = BUNDLED_CA;
    }
    return { ca: fs.readFileSync(caPath), rejectUnauthorized: true };
  }
  if (process.env.DB_SSL === 'true') {
    return { rejectUnauthorized: true };
  }
  return undefined;
}

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'geoattend_pro',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true,
  // Managed MySQL (Aiven) closes connections that have sat idle past its
  // wait_timeout. TCP keep-alive probes keep the socket live so the server is
  // less likely to drop an otherwise-healthy pooled connection out from under
  // us; idleTimeout retires a connection on our side after 60s idle so the
  // pool tends to hand out fresh ones rather than ones the server may have
  // already killed. Neither fully eliminates the race -- a connection can
  // still die between checkout and first query -- which is what the retry
  // wrapper below is for.
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  idleTimeout: 60000,
  ssl: buildSslConfig()
});

// A pooled connection can drop while idle (managed hosts reset idle sockets),
// and mysql2 emits that as an 'error' on the underlying pool. With no listener
// Node treats it as an unhandled 'error' event and crashes the whole process,
// so swallow it here -- the pool discards the dead connection and makes a new
// one on the next query. We only log; there's no request to fail.
pool.pool.on('error', (err) => {
  console.error('MySQL pool connection error (recovered):', err.code || err.message);
});

// A connection the pool hands out can turn out to be already dead (the server
// closed it while it was idle), so the very first query on it rejects with a
// fatal ECONNRESET / PROTOCOL_CONNECTION_LOST before the statement ever runs.
// Retrying once gets a fresh connection and the request succeeds instead of
// 500ing. We only retry these connection-level failures, and only once, so a
// genuine query error (or a real outage) still surfaces normally.
const FATAL_CONNECTION_CODES = new Set([
  'ECONNRESET',
  'PROTOCOL_CONNECTION_LOST',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ECONNREFUSED'
]);

function isRetriableConnectionError(err) {
  return !!err && (FATAL_CONNECTION_CODES.has(err.code) || err.fatal === true);
}

for (const method of ['query', 'execute']) {
  const original = pool[method].bind(pool);
  pool[method] = async (...args) => {
    try {
      return await original(...args);
    } catch (err) {
      if (!isRetriableConnectionError(err)) throw err;
      console.warn(`MySQL ${method} hit a dead connection (${err.code}); retrying once on a fresh connection.`);
      return await original(...args);
    }
  };
}

// Managed MySQL (Aiven) runs in UTC, but event times and the app's clock are
// Philippine time — so NOW() would be 8 hours behind every stored event time
// (auto time-outs firing late, check-ins saved in UTC). Pin each connection's
// session to +08:00; an offset works even without MySQL's timezone tables.
pool.pool.on('connection', (conn) => {
  conn.query(`SET time_zone = '${process.env.DB_TIMEZONE || '+08:00'}'`);
});

pool.getConnection()
  .then(conn => {
    console.log('MySQL connected successfully.');
    conn.release();
  })
  .catch(err => {
    console.error('MySQL connection failed:', err.message);
    console.error('Check your .env DB_* values and that MySQL is running.');
  });

module.exports = pool;
