/** Only local transactions enter this queue. A sync response is not a save ACK.
 * Keep the original delta and message ID until durable acknowledgement, including
 * across reconnects. Never infer pending writes from a Yjs state-vector diff:
 * deletion sets can be non-empty even when both replicas are already identical.
 */
export class UpdateOutbox {
  private entries: { id: string; update: Uint8Array }[] = [];
  private online = false;
  private inFlight: string | undefined;
  constructor(
    private send: (entry: { id: string; update: Uint8Array }) => boolean,
    private changed: (pending: boolean) => void,
  ) {}
  get pending() {
    return this.entries.length > 0;
  }
  enqueue(update: Uint8Array, id: string = crypto.randomUUID()) {
    if (this.entries.some(entry => entry.id === id)) return;
    this.entries.push({ id, update: update.slice() });
    this.changed(true);
    this.flush();
  }
  resume() {
    this.online = true;
    this.flush();
    this.changed(this.pending);
  }
  pause() {
    this.online = false;
    this.inFlight = undefined;
  }
  acknowledge(id: string) {
    if (this.entries[0]?.id !== id) return;
    this.entries.shift();
    this.inFlight = undefined;
    this.changed(this.pending);
    this.flush();
  }
  private flush() {
    const first = this.entries[0];
    if (!this.online || this.inFlight || !first) return;
    this.inFlight = first.id;
    if (!this.send(first)) {
      this.online = false;
      this.inFlight = undefined;
    }
  }
}
