// Minimal SOCKS5 client (no external dependencies).
// Connects through a SOCKS5 proxy and returns a socket that is already
// tunnelled to the target host:port. Supports "no auth" and
// username/password auth (RFC 1928 / RFC 1929).
const net = require('net');

class SocksError extends Error {}

/**
 * @param {Object} proxy { host, port, username, password }
 * @param {string} targetHost
 * @param {number} targetPort
 * @param {number} timeoutMs
 * @returns {Promise<net.Socket>} connected, tunnelled socket
 */
function connectViaSocks5(proxy, targetHost, targetPort, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (_) {}
      reject(err instanceof Error ? err : new SocksError(String(err)));
    };
    const timer = setTimeout(() => fail(new SocksError('SOCKS5 proxy connect timed out')), timeoutMs);
    const done = (sock) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(sock);
    };

    socket.on('error', fail);
    socket.on('connect', () => {
      // Greeting: version 5, methods we offer.
      const methods = proxy.username ? [0x02] : [0x00]; // 0x02 = user/pass, 0x00 = no auth
      socket.write(Buffer.from([0x05, methods.length, ...methods]));
    });

    let stage = 'greeting';
    let buf = Buffer.alloc(0);

    const need = (n) => buf.length >= n;

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        if (stage === 'greeting') {
          if (!need(2)) return;
          if (buf[0] !== 0x05) return fail(new SocksError('Proxy is not SOCKS5'));
          const method = buf[1];
          buf = buf.slice(2);
          if (method === 0xff) return fail(new SocksError('Proxy refused all auth methods'));
          if (method === 0x02) {
            stage = 'auth';
            const u = Buffer.from(proxy.username || '', 'utf8');
            const p = Buffer.from(proxy.password || '', 'utf8');
            socket.write(Buffer.concat([
              Buffer.from([0x01, u.length]), u,
              Buffer.from([p.length]), p,
            ]));
            return;
          }
          if (method !== 0x00) return fail(new SocksError('Unsupported SOCKS5 auth method: ' + method));
          stage = 'request';
          sendConnect();
        } else if (stage === 'auth') {
          if (!need(2)) return;
          if (buf[1] !== 0x00) return fail(new SocksError('SOCKS5 username/password rejected'));
          buf = buf.slice(2);
          stage = 'request';
          sendConnect();
        } else if (stage === 'request') {
          if (!need(4)) return;
          if (buf[1] !== 0x00) {
            const codes = { 1: 'general failure', 2: 'connection not allowed', 3: 'network unreachable', 4: 'host unreachable', 5: 'connection refused', 6: 'TTL expired', 7: 'command not supported', 8: 'address type not supported' };
            return fail(new SocksError('SOCKS5 connect failed: ' + (codes[buf[1]] || ('code ' + buf[1]))));
          }
          const atyp = buf[3];
          let headerLen = 4;
          if (atyp === 0x01) headerLen = 4 + 4 + 2;
          else if (atyp === 0x03) { if (!need(5)) return; headerLen = 4 + 1 + buf[4] + 2; }
          else if (atyp === 0x04) headerLen = 4 + 16 + 2;
          else return fail(new SocksError('SOCKS5: bad address type in reply'));
          if (!need(headerLen)) return;
          // Any bytes after the reply header belong to the target protocol.
          const leftover = buf.slice(headerLen);
          buf = Buffer.alloc(0);
          socket.removeAllListeners('data');
          if (leftover.length) socket.unshift(leftover);
          done(socket);
        }
      } catch (e) { fail(e); }
    });

    function sendConnect() {
      const hostBuf = Buffer.from(targetHost, 'utf8');
      const req = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
        hostBuf,
        Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
      ]);
      socket.write(req);
    }
  });
}

module.exports = { connectViaSocks5, SocksError };
