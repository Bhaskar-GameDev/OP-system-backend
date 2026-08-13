import { ArgumentsHost, ForbiddenException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WsExceptionsFilter, WsClientLike } from '../src/common/errors/ws-exceptions.filter';
import { AnalyticsService } from '../src/admin/analytics.service';
import { ArchivalService } from '../src/archival/archival.service';
import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * Failures that have no caller to catch them.
 *
 * The HTTP path has had `AllExceptionsFilter` since the start, and it is covered
 * as part of the integration suite. The two paths tested here had nothing:
 *
 *   1. socket message handlers — an unexpected throw left the client with no
 *      reply at all, waiting on a dashboard that never populated;
 *   2. scheduled jobs — an escaping error became an unhandled rejection whose
 *      log line named neither the job nor what it was doing.
 *
 * Both are pure, so unlike `observability.spec.ts` this file needs no database.
 */
describe('Exception handling without a caller', () => {
  /** Silence the filter's own logging; the assertions are about behaviour. */
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterAll(() => jest.restoreAllMocks());

  describe('WsExceptionsFilter', () => {
    function hostFor(client: WsClientLike, pattern = 'join'): ArgumentsHost {
      return {
        switchToWs: () => ({
          getClient: <T>() => client as T,
          getPattern: () => pattern,
        }),
      } as unknown as ArgumentsHost;
    }

    function clientSpy(): { client: WsClientLike; sent: Array<[string, unknown]> } {
      const sent: Array<[string, unknown]> = [];
      return {
        sent,
        client: { id: 'sock-1', emit: (event, payload) => sent.push([event, payload]) },
      };
    }

    it('answers the client on the error event clients already listen for', () => {
      const { client, sent } = clientSpy();
      new WsExceptionsFilter().catch(new TypeError('cannot read x of undefined'), hostFor(client));

      expect(sent).toHaveLength(1);
      const [event, payload] = sent[0];
      expect(event).toBe('error');
      expect(payload).toEqual({ message: 'internal server error', event: 'join' });
    });

    it('never puts internals on the wire', () => {
      // A Prisma message names columns and constraints, and a display board is
      // an unauthenticated socket.
      const { client, sent } = clientSpy();
      const prismaError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on Booking.token', {
        code: 'P2002',
        clientVersion: '5.0.0',
      });

      new WsExceptionsFilter().catch(prismaError, hostFor(client));

      expect(JSON.stringify(sent[0][1])).not.toContain('Booking.token');
      expect(JSON.stringify(sent[0][1])).not.toContain('P2002');
    });

    it('forwards a deliberately thrown message, which is written for the caller', () => {
      const { client, sent } = clientSpy();
      new WsExceptionsFilter().catch(new ForbiddenException('forbidden'), hostFor(client, 'op:join'));

      expect(sent[0][1]).toEqual({ message: 'forbidden', event: 'op:join' });
    });

    it('tells the client to retry when a dependency is unreachable', () => {
      // Otherwise a Redis/Postgres blip reads to the client exactly like being
      // denied the room, and it stops trying.
      const { client, sent } = clientSpy();
      const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

      new WsExceptionsFilter().catch(refused, hostFor(client));

      expect(sent[0][1]).toMatchObject({ message: 'service temporarily unavailable, please retry' });
    });

    it('survives a socket that dies while being notified', () => {
      // The dead socket is a plausible cause of the failure being handled; a
      // throw here would land straight back in the filter.
      const client: WsClientLike = {
        id: 'sock-2',
        emit: () => {
          throw new Error('socket closed');
        },
      };

      expect(() => new WsExceptionsFilter().catch(new Error('boom'), hostFor(client))).not.toThrow();
    });
  });

  describe('scheduled jobs', () => {
    it('contains a failing daily summary instead of leaking an unhandled rejection', async () => {
      const service = new AnalyticsService({} as unknown as PrismaService);
      jest.spyOn(service, 'runDailySummary').mockRejectedValue(new Error('database is down'));

      await expect(service.scheduledSummary()).resolves.toBeUndefined();
    });

    it('contains a failing archival sweep', async () => {
      const service = new ArchivalService({} as unknown as PrismaService);
      jest.spyOn(service, 'runSweep').mockRejectedValue(new Error('database is down'));

      await expect(service.scheduledSweep()).resolves.toBeUndefined();
    });

    it('still reports a successful run', async () => {
      const service = new ArchivalService({} as unknown as PrismaService);
      jest.spyOn(service, 'runSweep').mockResolvedValue({ archived: 3 });

      await expect(service.scheduledSweep()).resolves.toBeUndefined();
    });
  });
});
