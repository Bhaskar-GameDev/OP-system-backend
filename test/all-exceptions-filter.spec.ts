import { ArgumentsHost, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AllExceptionsFilter } from '../src/common/errors/all-exceptions.filter';

/**
 * Global exception filter. Pure — no DB. The contract that matters: a thrown
 * HttpException reaches the caller intact, and anything else is translated into
 * a status the caller can act on WITHOUT leaking the underlying driver message.
 */
describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let status: number;
  let body: Record<string, unknown>;
  let host: ArgumentsHost;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    status = 0;
    body = {};
    const res = {
      headersSent: false,
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: Record<string, unknown>) {
        body = payload;
        return payload;
      },
      end() {
        return undefined;
      },
    };
    host = {
      switchToHttp: () => ({
        getResponse: () => res,
        getRequest: () => ({ method: 'POST', url: '/voice/bookings' }),
      }),
    } as unknown as ArgumentsHost;
    // The filter logs every caught error (with a stack for 5xx); silence it so
    // the suite output isn't buried in deliberate failures.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('passes a deliberate HttpException through with its own message', () => {
    filter.catch(new ConflictException('no session is open for this doctor today'), host);
    expect(status).toBe(409);
    expect(body.message).toBe('no session is open for this doctor today');
  });

  it('keeps the 404 status of a NotFoundException', () => {
    filter.catch(new NotFoundException('doctor not found'), host);
    expect(status).toBe(404);
  });

  it('maps a Prisma unique-constraint violation to 409, not 500', () => {
    const err = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });
    filter.catch(err, host);
    expect(status).toBe(409);
  });

  it('maps a Prisma foreign-key violation to 400', () => {
    const err = new Prisma.PrismaClientKnownRequestError('FK constraint failed', {
      code: 'P2003',
      clientVersion: 'test',
    });
    filter.catch(err, host);
    expect(status).toBe(400);
  });

  it('reports an unreachable dependency as a retryable 503', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), {
      code: 'ECONNREFUSED',
    });
    filter.catch(err, host);
    expect(status).toBe(503);
    expect(body.message).toBe('service temporarily unavailable, please retry');
  });

  it('never leaks an internal error message to the caller', () => {
    filter.catch(new TypeError("Cannot read properties of undefined (reading 'clinicId')"), host);
    expect(status).toBe(500);
    expect(body.message).toBe('internal server error');
    expect(JSON.stringify(body)).not.toContain('clinicId');
  });

  it('includes the request path and a timestamp for correlation', () => {
    filter.catch(new Error('boom'), host);
    expect(body.path).toBe('/voice/bookings');
    expect(typeof body.timestamp).toBe('string');
  });
});
