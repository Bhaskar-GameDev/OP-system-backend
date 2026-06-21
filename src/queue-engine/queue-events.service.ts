import { EventEmitter } from 'node:events';
import { Injectable } from '@nestjs/common';
import { SessionKey } from './token.service';

export const SESSION_CHANGED = 'session-changed';

/**
 * In-process event bus for queue state changes. The Queue Engine emits
 * `session-changed` after every mutation; the realtime gateway subscribes and
 * fans the new state out to the right rooms. Keeps trigger logic out of the
 * mutation code (one emit per op) rather than scattering socket calls around.
 */
@Injectable()
export class QueueEventsService {
  private readonly emitter = new EventEmitter();

  constructor() {
    // many sockets/handlers may listen; avoid the default 10-listener warning
    this.emitter.setMaxListeners(0);
  }

  sessionChanged(session: SessionKey): void {
    this.emitter.emit(SESSION_CHANGED, session);
  }

  onSessionChanged(handler: (session: SessionKey) => void): () => void {
    this.emitter.on(SESSION_CHANGED, handler);
    return () => this.emitter.off(SESSION_CHANGED, handler);
  }
}
