import Redis from 'ioredis';
import { config } from './config';
import { createLogger } from './logger';

const log = createLogger('redis');

interface RedisOptions {
  /**
   * Set for connections that issue blocking commands (BRPOP, BRPOPLPUSH).
   *
   * ioredis counts the time a blocking command spends waiting against
   * maxRetriesPerRequest and will abort it. A worker parked on BRPOP for 5s is
   * behaving correctly, not failing — so blocking connections must opt out of
   * that limit entirely.
   */
  blocking?: boolean;
}

export function createRedis(name: string, options: RedisOptions = {}): Redis {
  const client = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    maxRetriesPerRequest: options.blocking ? null : 3,
    retryStrategy(times) {
      const delayMs = Math.min(times * 200, 2000);
      log.warn('redis reconnecting', { name, attempt: times, delayMs });
      return delayMs;
    },
  });

  client.on('connect', () => log.info('redis connected', { name }));
  client.on('error', (err: Error) =>
    log.error('redis error', { name, error: err.message }),
  );

  return client;
}