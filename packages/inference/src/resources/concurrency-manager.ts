export class ConcurrencyManager {
  private activeLocalRequests = 0
  private maxLocalConcurrency: number

  constructor(maxLocalConcurrency = 1) {
    this.maxLocalConcurrency = maxLocalConcurrency
  }

  canAcquire(): boolean {
    return this.activeLocalRequests < this.maxLocalConcurrency
  }

  acquire(): boolean {
    if (!this.canAcquire()) return false
    this.activeLocalRequests++
    return true
  }

  release(): void {
    if (this.activeLocalRequests > 0) {
      this.activeLocalRequests--
    }
  }

  getActiveCount(): number {
    return this.activeLocalRequests
  }
}
