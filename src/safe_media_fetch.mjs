import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { inspectImage, MAX_IMAGE_BYTES } from './media_image.mjs';

const blocked = new net.BlockList();
for (const [network, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]]) blocked.addSubnet(network, prefix, 'ipv4');
const global6 = new net.BlockList(); global6.addSubnet('2000::', 3, 'ipv6');
for (const [network,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) blocked.addSubnet(network,prefix,'ipv6');
export function isPublicMediaAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return family === 6 && !address.includes('%') && global6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export function validateMediaUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 8192) throw new Error('media_invalid_url');
  let url; try { url = new URL(raw.startsWith('//') ? `https:${raw}` : raw); } catch { throw new Error('media_invalid_url'); }
  const host = url.hostname.toLowerCase();
  // These Tencent image domains appear in QQ attachment / emoji delivery. Never infer a URL from an emoji id.
  const allowed = host === 'qpic.cn' || host.endsWith('.qpic.cn') || ['multimedia.nt.qq.com.cn', 'gxh.vip.qq.com'].includes(host);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !allowed || url.hash) throw new Error('media_url_not_allowed');
  return url;
}

const limited = (promise, milliseconds) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('media_fetch_timeout')), milliseconds); })]).finally(() => clearTimeout(timer));
};

function requestImage(url, address, budget, request) {
  return new Promise((resolve, reject) => {
    let req, response, settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => { finish(new Error('media_fetch_timeout')); req?.destroy(); response?.destroy(); }, budget);
    try {
      req = request({
        protocol: 'https:', hostname: url.hostname, port: 443, path: url.pathname + url.search,
        method: 'GET', servername: url.hostname, rejectUnauthorized: true, agent: false,
        headers: { Accept: 'image/png,image/jpeg,image/gif,image/webp', 'Accept-Encoding': 'identity', 'User-Agent': 'QQ-Companion/1.0' },
        // Pin the already validated address while retaining the original TLS hostname.
        lookup: (_host, options, callback) => {
          if (typeof options === 'function') { callback = options; options = {}; }
          const item = { address, family: net.isIP(address) };
          if (options?.all) callback(null, [item]); else callback(null, item.address, item.family);
        }
      }, res => {
        response = res;
        res.on('error', () => finish(new Error('media_fetch_network')));
        res.on('aborted', () => finish(new Error('media_fetch_network')));
        res.on('close', () => { if (!res.complete) finish(new Error('media_fetch_network')); });
        if (settled) return res.destroy();
        if ([301,302,303,307,308].includes(res.statusCode)) {
          finish(null, { redirect: res.headers.location }); res.destroy(); return;
        }
        if (res.statusCode !== 200) { finish(new Error(`media_fetch_http_${res.statusCode}`)); res.destroy(); return; }
        if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { finish(new Error('media_compressed_response')); res.destroy(); return; }
        if (Number(res.headers['content-length']) > MAX_IMAGE_BYTES) { finish(new Error('media_image_size')); res.destroy(); return; }
        const chunks = []; let size = 0;
        res.on('data', chunk => {
          if (settled) return;
          size += chunk.length;
          if (size > MAX_IMAGE_BYTES) { finish(new Error('media_image_size')); res.destroy(); return; }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          try { finish(null, { image: inspectImage(Buffer.concat(chunks), res.headers['content-type'] || '',{allowExtended:true}) }); }
          catch (error) { finish(error); }
        });
      });
      req.on('error', () => finish(new Error('media_fetch_network'))); req.end();
    } catch { finish(new Error('media_fetch_network')); req?.destroy(); }
  });
}

export async function fetchMediaImage(raw, { lookup = dns.lookup, request = https.request, timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + Math.min(20000, Math.max(1000, timeoutMs));
  let url = validateMediaUrl(raw);
  for (let hop = 0; hop <= 3; hop++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('media_fetch_timeout');
    const addresses = await limited(lookup(url.hostname, { all: true, verbatim: true }), Math.min(5000, remaining));
    if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32 || addresses.some(item => !isPublicMediaAddress(item.address))) throw new Error('media_private_address');
    const ordered = addresses.filter(item => net.isIP(item.address) === 4).concat(addresses.filter(item => net.isIP(item.address) === 6)).slice(0,4);
    let result, lastError;
    for (const item of ordered) {
      const budget = Math.min(7000, deadline - Date.now());
      if (budget <= 0) throw new Error('media_fetch_timeout');
      try { result = await requestImage(url, item.address, budget, request); break; }
      catch (error) { lastError = error; if (!['media_fetch_network','media_fetch_timeout'].includes(error.message)) throw error; }
    }
    if (!result) throw lastError || new Error('media_fetch_network');
    if (result.image) return result.image;
    if (typeof result.redirect !== 'string' || !result.redirect) throw new Error('media_invalid_redirect');
    url = validateMediaUrl(new URL(result.redirect, url).href);
  }
  throw new Error('media_too_many_redirects');
}
