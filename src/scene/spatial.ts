/**
 * Uniform spatial hash for panel culling and picking.
 * World coordinates are positive in phase 0, but the key handles negatives.
 */
export class SpatialHash {
  private readonly cellSize: number;
  private readonly cells = new Map<number, number[]>();
  private readonly marks: Uint32Array;
  private stamp = 0;
  private readonly result: number[] = [];

  constructor(panelCount: number, cellSize = 512) {
    this.cellSize = cellSize;
    this.marks = new Uint32Array(panelCount);
  }

  private key(cellX: number, cellY: number): number {
    return (cellX + 32768) * 65536 + (cellY + 32768);
  }

  insert(index: number, x: number, y: number, w: number, h: number): void {
    const minX = Math.floor(x / this.cellSize);
    const minY = Math.floor(y / this.cellSize);
    const maxX = Math.floor((x + w) / this.cellSize);
    const maxY = Math.floor((y + h) / this.cellSize);

    for (let cy = minY; cy <= maxY; cy += 1) {
      for (let cx = minX; cx <= maxX; cx += 1) {
        const key = this.key(cx, cy);
        let bucket = this.cells.get(key);
        if (!bucket) {
          bucket = [];
          this.cells.set(key, bucket);
        }
        bucket.push(index);
      }
    }
  }

  /**
   * Returns panel indices whose buckets overlap the query rect.
   * The returned array is reused between calls; copy it if you need to retain it.
   */
  query(x: number, y: number, w: number, h: number): number[] {
    this.stamp += 1;
    if (this.stamp > 0xffffffff) this.stamp = 1;
    this.result.length = 0;

    const minX = Math.floor(x / this.cellSize);
    const minY = Math.floor(y / this.cellSize);
    const maxX = Math.floor((x + w) / this.cellSize);
    const maxY = Math.floor((y + h) / this.cellSize);

    for (let cy = minY; cy <= maxY; cy += 1) {
      for (let cx = minX; cx <= maxX; cx += 1) {
        const bucket = this.cells.get(this.key(cx, cy));
        if (!bucket) continue;
        for (const index of bucket) {
          if (this.marks[index] === this.stamp) continue;
          this.marks[index] = this.stamp;
          this.result.push(index);
        }
      }
    }

    return this.result;
  }
}
