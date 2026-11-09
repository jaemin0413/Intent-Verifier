import { readFile } from "node:fs/promises";

// MemAvailable counts reclaimable cache, which os.freemem() does not. Other systems report no limit.
export async function availableMemoryMb(read = readFile) {
  try { return Number((await read("/proc/meminfo", "utf8")).match(/MemAvailable:\s+(\d+)/)[1]) / 1024; }
  catch { return Infinity; }
}

export const AI_WORK = { weight: 1, memoryMb: 350 };
export const BUILD_WORK = { weight: 3, memoryMb: 900 };

// Other applications share this machine, so heavy work starts in order and only when memory allows.
// A build fills the whole capacity; AI calls run beside each other but never beside a build.
export class WorkGate {
  constructor({ capacity = 3, available = availableMemoryMb, pollMs = 5000, timeoutMs = 600000 } = {}) {
    Object.assign(this, { capacity, available, pollMs, timeoutMs, used: 0, waiting: [] });
  }
  drain() {
    while (this.waiting.length && this.used + this.waiting[0].weight <= this.capacity) {
      const next = this.waiting.shift();
      this.used += next.weight;
      next.start();
    }
  }
  async enoughMemory(memoryMb) {
    const deadline = Date.now() + this.timeoutMs;
    while ((await this.available()) < memoryMb) {
      if (Date.now() >= deadline) throw new Error("서버 메모리가 부족해 작업을 시작하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }
  async run({ weight, memoryMb }, task) {
    await new Promise((start) => { this.waiting.push({ weight, start }); this.drain(); });
    try { await this.enoughMemory(memoryMb); return await task(); }
    finally { this.used -= weight; this.drain(); }
  }
}
