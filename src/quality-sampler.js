/** Small timer-driven sampler with single-flight processing and explicit teardown. */
export class QualitySampler {
  constructor({ sample, intervalMs = 750, setTimer = setInterval, clearTimer = clearInterval, onError = () => {} } = {}) {
    this.sample = sample;
    this.intervalMs = intervalMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onError = onError;
    this.timer = null;
    this.running = false;
    this.busy = false;
    this.generation = 0;
  }

  start() {
    if (this.running || typeof this.sample !== 'function') return;
    this.running = true;
    const generation = ++this.generation;
    void this.#tick(generation);
    this.timer = this.setTimer(() => { void this.#tick(generation); }, this.intervalMs);
  }

  stop() {
    if (!this.running && this.timer === null) return;
    this.running = false;
    this.generation++;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  async #tick(generation) {
    if (!this.running || generation !== this.generation || this.busy) return;
    this.busy = true;
    try { await this.sample(); }
    catch (error) { try { this.onError(error); } catch {} }
    finally { this.busy = false; }
  }
}
