import { Injectable, NestMiddleware } from '@nestjs/common';
import {
  REQUEST_ID_HEADER,
  RequestContext,
  resolveRequestId,
  runWithRequestContext,
} from './request-context';

/** Only the members this middleware touches (@types/express is not a dep). */
interface RequestLike {
  method?: string;
  originalUrl?: string;
  url?: string;
  headers: Record<string, unknown>;
}
interface ResponseLike {
  setHeader(name: string, value: string): void;
}

/**
 * Opens a request context for every HTTP request and echoes the id back.
 *
 * Echoing matters as much as generating: when a hospital reports "the desk got
 * an error at 11:04", the id on their screen is the only thing that finds the
 * matching server log without guessing from timestamps.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: RequestLike, res: ResponseLike, next: () => void): void {
    const context: RequestContext = {
      requestId: resolveRequestId(req.headers[REQUEST_ID_HEADER]),
      method: req.method,
      url: req.originalUrl ?? req.url,
    };
    res.setHeader(REQUEST_ID_HEADER, context.requestId);
    runWithRequestContext(context, next);
  }
}
