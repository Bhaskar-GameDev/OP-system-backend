import { INestApplicationContext, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';

/**
 * Socket.io adapter backed by Redis pub/sub.
 *
 * Without it, rooms live in the default in-memory adapter — a per-process view.
 * The moment a second backend replica exists, a client connected to instance A
 * stops receiving events emitted by instance B: the receptionist's dashboard
 * simply goes quiet while every HTTP call still succeeds. That failure is
 * partial and silent, which is why this belongs in place BEFORE anyone scales
 * out, not at the moment they do.
 *
 * Single-instance deployments are unaffected in behaviour: the adapter
 * publishes to Redis and receives its own messages back, which costs one extra
 * round trip per broadcast and buys the ability to add a replica without a
 * silent regression.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private clients: Redis[] = [];

  constructor(private readonly app: INestApplicationContext) {
    super(app);
  }

  /**
   * Open the pub/sub pair. Called once at bootstrap, before the server is
   * created, because `createIOServer` is synchronous.
   *
   * Socket.io needs TWO connections: a subscriber cannot issue normal commands
   * while subscribed, so publishing and subscribing cannot share one client.
   * These are separate from `RedisService`'s client for the same reason — the
   * queue engine issues ordinary commands on it continuously.
   */
  async connect(): Promise<void> {
    const config = this.app.get(ConfigService);
    const options = {
      host: config.get<string>('REDIS_HOST', 'localhost'),
      port: config.get<number>('REDIS_PORT', 6379),
      password: config.get<string>('REDIS_PASSWORD') || undefined,
      maxRetriesPerRequest: null,
    };

    const pubClient = new Redis(options);
    const subClient = pubClient.duplicate();
    this.clients = [pubClient, subClient];

    for (const client of this.clients) {
      client.on('error', (err) => this.logger.error(`socket adapter redis: ${err.message}`));
    }

    await Promise.all([pubClient.ping(), subClient.ping()]);
    this.adapterConstructor = createAdapter(pubClient, subClient);
    this.logger.log(`Socket.io Redis adapter connected (${options.host}:${options.port})`);
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    } else {
      // Reached only if connect() was skipped. Say so loudly rather than
      // running on the in-memory adapter and looking fine until a second
      // replica appears.
      this.logger.warn(
        'Socket.io Redis adapter NOT installed — connect() was not awaited. ' +
          'Realtime fan-out will not cross instances.',
      );
    }
    return server;
  }

  async close(): Promise<void> {
    await Promise.all(this.clients.map((c) => c.quit().catch(() => undefined)));
    this.clients = [];
  }
}
