import * as dns from 'dns';
import * as fs from 'fs';
import { isIP, Socket } from 'net';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import { promisify } from 'util';
import useThrottle from '@hyurl/utils/useThrottle';
import isEmpty from '@hyurl/utils/isEmpty';
import timestamp from '@hyurl/utils/timestamp';
import { sample } from 'lodash';

type Family = 0 | 4 | 6;
type FamilyWithZero = 4 | 6;
interface AddressInfo {
  address: string;
  family: FamilyWithZero;
}

type AddressInfoDetail = AddressInfo & { expireAt: number };
type LookupCallback<T extends string | AddressInfo[]> = (
  err: NodeJS.ErrnoException,
  address: T,
  family?: FamilyWithZero
) => void;

const readFile = promisify(fs.readFile);
const resolve4 = promisify(dns.resolve4);
const resolve6 = promisify(dns.resolve6);
const hostsThrottle = useThrottle('dnsLookup:loadHostsConfig', 10_000);
const Cache: Record<string, AddressInfoDetail[]> = {};

let HostsConfig: Record<string, AddressInfoDetail[]>;
const timer = setInterval(async () => { // reload hosts file for every 10 seconds.
  HostsConfig = await hostsThrottle(loadHostsConfig);
}, 10_000);

timer.unref(); // allow the process to exit once there are no more pending jobs.

async function loadHostsConfig(file = '') {
  if (!file) {
    if (process.platform === 'win32') {
      file = 'c:\\Windows\\System32\\Drivers\\etc\\hosts';
    } else {
      file = '/etc/hosts';
    }
  }

  return (await readFile(file, 'utf8')).split(/\r\n|\n/)
    .map(line => line.trim())
    .filter(line => !line.startsWith('#'))
    .map(line => line.split(/\s+/))
    .reduce((configs: Record<string, AddressInfoDetail[]>, segments) => {
      const expireAt = timestamp() + 10; // mark available for 10 seconds

      segments.slice(1).forEach((hostname) => {
        const family = isIP(segments[0]) as Family;

        if (family) {
          (configs[hostname] || (configs[hostname] = [])).push({
            address: segments[0],
            family,
            expireAt,
          });
        }
      });

      return configs;
    }, {});
}

/**
 * Queries IP addresses of the given hostname, this operation is async and
 * atomic, and uses cache when available. When `family` is omitted, both
 * `A (IPv4)` and `AAAA (IPv6)` records are searched, however only one address
 * will be returned if `options.all` is not set.
 *
 * NOTE: The internal TTL for an identical query is 10 seconds.
 */
export function lookup(hostname: string, family?: Family): Promise<string>;
export function lookup(hostname: string, callback: LookupCallback<string>): void;
export function lookup(
  hostname: string,
  family: Family | { family?: Family },
  callback: LookupCallback<string>
): void;
export function lookup(
  hostname: string,
  options: { family?: Family }
): Promise<string>;
export function lookup(
  hostname: string,
  options: { family?: Family; all: true }
): Promise<AddressInfo[]>;
export function lookup(
  hostname: string,
  options: { family?: Family; all: true },
  callback: LookupCallback<AddressInfo[]>
): void;
export function lookup(
  hostname: string,
  options: any = void 0,
  callback: any = null,
): any {
  let family: Family = 0;
  let all = false;

  if (typeof options === 'object') {
    family = options.family || 0;
    all = options.all || false;
  } else if (typeof options === 'number') {
    family = options as Family;
  } else if (typeof options === 'function') {
    callback = options;
  }

  const _family = isIP(hostname) as Family;

  if (_family) {
    if (all) {
      if (callback) {
        return callback(null, [{ address: hostname, family: _family }]);
      }

      return Promise.resolve([{ address: hostname, family: _family }]);
    }

    if (callback) {
      return callback(null, hostname, _family);
    }

    return Promise.resolve(hostname);
  }

  let query;
  let expiredCache: AddressInfoDetail[] | undefined;
  // If local cache contains records of the target hostname, try to retrieve
  // them and prevent network query.
  if (!isEmpty(Cache[hostname])) {
    const now = timestamp();
    let addresses = Cache[hostname].filter(a => a.expireAt > now);
    addresses = family ? addresses.filter(a => a.family === family) : addresses;

    if (!isEmpty(addresses)) {
      query = Promise.resolve(addresses);
      console.log(`[better-loopup]: ${hostname}, cache`);
    } else {
      // 存储已经过期的缓存，供后面请求 dns 出错使用
      expiredCache = !family ? Cache[hostname] : Cache[hostname].filter(a => a.family === family);
    }
  }

  // If local cache doesn't contain available records, then goto network
  // query.
  query = query || queryDns({
    all,
    family,
    hostname,
    expiredCache,
  });

  // Make sure the result only contains 'address' and 'family'.
  query = query.then((addresses) => {
    addresses = family ? addresses.filter(a => a.family === family) : addresses;
    const addressesFilter = addresses.map(({ address, family }) => ({ address, family }));
    return all ? addressesFilter : sample(addressesFilter) as AddressInfoDetail;
  });

  if (!callback) {
    return query;
  }

  query.then((addresses) => {
    if (Array.isArray(addresses)) {
      callback(null, addresses);
    } else {
      callback(null, addresses.address, addresses.family);
    }
  }).catch((err) => {
    callback(err, void 0);
  });
}

async function getDnsByResolve(hostname: string, family: FamilyWithZero = 4) {
  const fun = family === 6 ? resolve6 : resolve4;
  const records = await fun(hostname, { ttl: true });
  console.log(`[better-loopup]: ${hostname}, resolve${family}`);
  const now = timestamp();
  const addresses = records.filter(record => record?.address).map(({ address, ttl }) => ({
    family,
    address,
    expireAt: Math.max(ttl + now, 10),
  }));
  console.log(addresses);
  if (Cache[hostname]) {
    Cache[hostname] = Cache[hostname].filter(a => a.family !== family);
    Cache[hostname].push(...addresses);
  } else {
    Cache[hostname] = addresses;
  }

  return addresses;
}

function queryDns({
  all,
  family,
  hostname,
  expiredCache,
}: {
  hostname: string;
  family: Family;
  all: boolean;
  expiredCache?: AddressInfoDetail[];
}) {
  return useThrottle(`dnsLookup:${hostname}:${family}:${all}`, 10_000)(async () => {
    if (!HostsConfig) {
      HostsConfig = await hostsThrottle(loadHostsConfig);
    }

    const result: AddressInfoDetail[] = HostsConfig[hostname] || [];
    let err4;
    let err6;

    if (isEmpty(result)) {
      if (!family || family === 4) {
        await getDnsByResolve(hostname, 4).then((addresses) => {
          result.push(...addresses);
        })
          .catch((err) => {
            console.log('resolve4 error:', err?.message);
            err4 = err;
          });
      }

      if (!family || family === 6) {
        try {
          await getDnsByResolve(hostname, 6).then((addresses) => {
            result.push(...addresses);
          });
        } catch (e: any) {
          console.log('resolve6 error:', e?.message);
          if (e.code === 'ENODATA'
            && e.syscall === 'queryAaaa'
            && family === 6
          ) {
            await getDnsByResolve(hostname, 4).then((addresses) => {
              result.push(...addresses.map(record => ({
                address: `::ffff:${record.address}`,
                family: 6 as const,
                expireAt: record.expireAt,
              })));
            })
              .catch((err) => {
                err6 = err;
                console.log('resolve6 error1:', err?.message);
              });
          } else {
            err6 = e;
          }
        }
      }
    }

    let err;
    if (err4 && err6 && !family) {
      err = Object.assign(
        new Error(`resolve4 and resolve6 error: queryA and queryAaaa ENODATA ${hostname}`),
        {
          errno: undefined,
          code: 'ENODATA',
          syscall: undefined,
          hostname,
        },
      );
    } else if (err4 && family === 4) {
      err = err4;
    } else if (err6 && family === 6) {
      err = err6;
    } else {
      return result;
    }

    if (expiredCache && expiredCache?.length > 0) {
      return expiredCache;
    }

    throw err;
  });
}

/**
 * Attaches the custom lookup functionality to the given `agent`, the `family`
 * argument configures the default IP family used to resolve addresses when no
 * `family` option is specified in the `http.request()`, the default value is
 * `0`.
 */
export function install<T extends HttpAgent | HttpsAgent>(
  agent: T & {
    createConnection?: (options: any, callback: Function) => Socket;
  },
  family: Family = 0,
): T {
  const tryAttach = (options: Record<string, any>) => {
    if (!options.lookup) {
      options.lookup = function (
        hostname: string,
        params: any,
        cb: LookupCallback<string>,
      ) {
        return lookup(hostname, params.family ?? family, cb);
      };
    }
  };

  if (typeof agent.createConnection === 'function') {
    const tmp = agent.createConnection;
    agent.createConnection = function (options, callback) {
      tryAttach(options);
      return tmp.call(agent, options, callback);
    };

    return agent;
  }

  if (isHttpsProxyAgent(agent)) {
    tryAttach(agent.proxy);
    return agent;
  }

  throw new TypeError('Cannot install lookup function on the given agent');
}

function isHttpsProxyAgent(agent: any): agent is { proxy: Record<string, any> } {
  return agent.constructor.name === 'HttpsProxyAgent'
        && typeof agent.proxy === 'object';
}
