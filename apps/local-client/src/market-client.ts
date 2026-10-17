import WebSocket from 'ws';
import {
  MarketSnapshotSchema,
  EventEnvelopeSchema,
  type MarketSnapshot,
  type EventEnvelope,
} from '@rgb-exchange/contracts';

export class MarketClient {
  connected = false;
  sequence = 0;
  private seen = new Set<string>();
  private ws?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private backoff = 250;
  constructor(
    readonly url: string,
    private readonly token: string,
    private readonly onEvent: (event: EventEnvelope) => void = () => {},
  ) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
      throw new Error('Invalid market URL');
    if (
      parsed.protocol === 'http:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    )
      throw new Error('Remote market requires HTTPS');
  }
  async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    const response = await fetch(new URL(path, this.url), {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(error.error || `Market HTTP ${response.status}`);
    }
    this.connected = true;
    return response.json();
  }
  accept(event: EventEnvelope): boolean {
    EventEnvelopeSchema.parse(event);
    if (this.seen.has(event.eventId) || event.sequence <= this.sequence) return false;
    this.seen.add(event.eventId);
    this.sequence = event.sequence;
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!);
    this.onEvent(event);
    return true;
  }
  async snapshot(): Promise<MarketSnapshot> {
    const result = MarketSnapshotSchema.parse(
      await this.request(`/snapshot?afterSequence=${this.sequence}`),
    );
    for (const event of [...result.events].sort((a, b) => a.sequence - b.sequence))
      this.accept(event);
    this.sequence = Math.max(this.sequence, result.sequence);
    return result;
  }
  connect(): void {
    if (
      this.closed ||
      this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CONNECTING
    )
      return;
    const url = new URL('/events', this.url);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(url);
    this.ws.on('open', () =>
      this.ws?.send(
        JSON.stringify({ type: 'authenticate', token: this.token, afterSequence: this.sequence }),
      ),
    );
    this.ws.on('message', (data) => {
      try {
        const message = JSON.parse(String(data));
        const event = EventEnvelopeSchema.safeParse(message.event ?? message);
        if (event.success) {
          this.accept(event.data);
          this.connected = true;
          this.backoff = 250;
        } else if (message.type === 'snapshot' || message.type === 'authenticated') {
          this.connected = true;
          this.backoff = 250;
          // Fetch a full authorized snapshot after every reconnect; events alone may have a gap.
          void this.snapshot().catch(() => {
            this.connected = false;
          });
        }
      } catch {
        /* Untrusted event cannot trigger publication or signing. */
      }
    });
    this.ws.on('error', () => {
      this.connected = false;
    });
    this.ws.on('close', () => {
      this.connected = false;
      if (!this.closed) {
        this.timer = setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 10_000);
      }
    });
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.ws?.close();
  }
}
