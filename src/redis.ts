import Redis from 'ioredis';
import { config } from './config';
import { createLogger } from './logger';

const log = createLogger('redis');

export function createRedis(name: string): Redis {
  const client = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    maxRetriesPerRequest: 3,
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