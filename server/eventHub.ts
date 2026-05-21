type SseRequest = import("node:http").IncomingMessage;
type SseResponse = import("node:http").ServerResponse;

export interface ServerEvent {
  type: string;
  payload: unknown;
  at: number;
}

interface SseClient {
  close(): void;
  send(eventName: string, payload: unknown): void;
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
  private readonly clients = new Set<SseClient>();
  private readonly history = new RingBuffer<ServerEvent>(300);

  add(req: SseRequest, res: SseResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write("\n");
    const client: SseClient = {
      close: () => undefined,
      send: (eventName, payload) => {
        res.write(`event: ${eventName}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };
    this.clients.add(client);
    client.send("hello", { serverTime: new Date().toISOString(), history: this.history.snapshot() });

    const keepAlive = setInterval(() => {
      if (!res.destroyed) {
        res.write(": keepalive\n\n");
      }
    }, 25_000);

    req.on("close", () => {
      clearInterval(keepAlive);
      this.clients.delete(client);
    });
  }

  stream(signal?: AbortSignal): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let client: SseClient | null = null;
    let keepAlive: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (keepAlive) {
        clearInterval(keepAlive);
        keepAlive = null;
      }
      if (client) {
        this.clients.delete(client);
        client = null;
      }
    };

    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        client = {
          close: cleanup,
          send: (eventName, payload) => {
            controller.enqueue(encoder.encode(`event: ${eventName}\n`));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          }
        };
        this.clients.add(client);
        client.send("hello", { serverTime: new Date().toISOString(), history: this.history.snapshot() });
        keepAlive = setInterval(() => {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        }, 25_000);
        signal?.addEventListener("abort", cleanup, { once: true });
      },
      cancel: cleanup
    });
  }

  broadcast(type: string, payload: unknown): void {
    const event = { type, payload, at: Date.now() };
    this.history.push(event);
    for (const client of this.clients) {
      client.send("message", event);
    }
  }
}
