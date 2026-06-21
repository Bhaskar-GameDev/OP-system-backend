import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Thin wrapper over a single ioredis connection.
 *
 * The Queue Engine relies on Redis atomic primitives (INCR, ZADD, EVAL).
 * Exposing the raw client lets services issue those directly — we never do
 * read-modify-write in application code for token/order state.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client!: Redis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const host = this.config.get<string>('REDIS_HOST', 'localhost');
    const port = this.config.get<number>('REDIS_PORT', 6379);
    const password = this.config.get<string>('REDIS_PASSWORD') || undefined;

    this.client = new Redis({
      host,
      port,
      password,
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });

    this.client.on('error', (err) => this.logger.error(err.message));
    this.client.on('connect', () => this.logger.log(`Redis connected ${host}:${port}`));
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.quit();
    }
  }

  /** Raw client — use for atomic ops (INCR / ZADD / pipeline / eval). */
  get redis(): Redis {
    return this.client;
  }

  /**
   * Register a Lua script as a callable command on the client.
   * Lua runs atomically server-side, so multi-step queue mutations
   * (e.g. pop-and-advance) stay race-free.
   */
  defineCommand(
    name: string,
    options: { numberOfKeys: number; lua: string },
  ): void {
    // ioredis attaches the command dynamically; guard against re-define.
    const hasCommand = (this.client as unknown as Record<string, unknown>)[name];
    if (!hasCommand) {
      this.client.defineCommand(name, options);
    }
  }
}
