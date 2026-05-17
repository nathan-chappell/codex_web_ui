type SseResponse = import("node:http").ServerResponse;
type SseRequest = import("node:http").IncomingMessage;

export interface ServerEvent {
  type: string;
  payload: unknown;
  at: number;
}

class RingBuffer<T> {
  private readonly items: T[] = [];

  constructor(private readonly limit: number) {}

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.limit) {
      this.items.splice(0, this.items.length - this.limit);
    }
  }

  snapshot(): T[] {
    return [...this.items];
  }
}

export class EventHub {
  private readonly clients = new Set<SseResponse>();
  private readonly history = new RingBuffer<ServerEvent>(300);

  add(req: SseRequest, res: SseResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write("\n");
    this.clients.add(res);
    this.send(res, "hello", { serverTime: new Date().toISOString(), history: this.history.snapshot() });

    const keepAlive = setInterval(() => {
      if (!res.destroyed) {
        res.write(": keepalive\n\n");
      }
    }, 25_000);

    req.on("close", () => {
      clearInterval(keepAlive);
      this.clients.delete(res);
    });
  }

  broadcast(type: string, payload: unknown): void {
    const event = { type, payload, at: Date.now() };
    this.history.push(event);
    for (const client of this.clients) {
      this.send(client, "message", event);
    }
  }

  private send(res: SseResponse, eventName: string, payload: unknown): void {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}
