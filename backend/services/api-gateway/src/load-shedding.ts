import { Request, Response, NextFunction, RequestHandler } from 'express';
import { counter, gauge } from '@banksphere/common';

const shed = counter('gateway_shed_total', 'Requests refused because this replica was at capacity', ['reason']);
const open = gauge('gateway_open_requests', 'Requests being handled by this replica', ['kind']);

/**
 * Load shedding: past a fixed number of concurrent requests a replica answers 503 at once instead of queueing
 * work it can't finish in time (queueing turns overload into timeouts for everyone). Streams are long-lived and
 * nearly idle, so they have their own, much larger cap and never count against the request cap. Health checks
 * are registered before this middleware and are never shed.
 */
export class LoadShedder {
  private inflight = 0;
  private streams = 0;

  constructor(
    private readonly maxInflight: number,
    private readonly maxStreams: number
  ) {}

  public get counts(): { inflight: number; streams: number } {
    return { inflight: this.inflight, streams: this.streams };
  }

  public middleware(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
      const streaming = Boolean(req.edge?.streaming);
      if (streaming ? this.streams >= this.maxStreams : this.inflight >= this.maxInflight) {
        shed.inc({ reason: streaming ? 'streams' : 'inflight' });
        res.setHeader('Retry-After', '1');
        res.status(503).json({
          error: { code: 'SERVER_BUSY', message: 'The service is busy, please retry shortly', correlationId: req.correlationId },
        });
        return;
      }
      const kind = streaming ? 'stream' : 'request';
      if (streaming) this.streams += 1;
      else this.inflight += 1;
      open.inc({ kind });
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        if (streaming) this.streams -= 1;
        else this.inflight -= 1;
        open.dec({ kind });
      };
      // 'finish' for completed responses, 'close' for aborted ones (whichever comes first)
      res.on('finish', release);
      res.on('close', release);
      next();
    };
  }
}
