/**
 * ?????CS336 ???
 * ???packages/gateway/fileContentCache.ts
 * ???Gateway ?????
 * ??????? Agent ?????????????????????
 * ???????????????????????????????????? README ????????????????
 */
import * as crypto from "node:crypto";

interface CacheEntry {
  content: string;
  hash: string;
  sizeBytes: number;
  lastAccess: number;
}

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_TOTAL_BYTES = 10 * 1024 * 1024;

export class FileContentCache {
  private readonly cache = new Map<string, CacheEntry>();
  private totalBytes = 0;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES, maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES) {
    this.maxEntries = maxEntries;
    this.maxTotalBytes = maxTotalBytes;
  }

  get(filePath: string): CacheEntry | undefined {
    const entry = this.cache.get(filePath);
    if (entry) {
      entry.lastAccess = Date.now();
      this.cache.delete(filePath);
      this.cache.set(filePath, entry);
    }
    return entry;
  }

  put(filePath: string, content: string, hash?: string): void {
    const existing = this.cache.get(filePath);
    if (existing) {
      this.totalBytes -= existing.sizeBytes;
      this.cache.delete(filePath);
    }

    const sizeBytes = Buffer.byteLength(content, "utf8");
    const computedHash = hash ?? crypto.createHash("md5").update(content).digest("hex");

    while ((this.cache.size >= this.maxEntries || this.totalBytes + sizeBytes > this.maxTotalBytes) && this.cache.size > 0) {
      this.evictOldest();
    }

    this.cache.set(filePath, {
      content,
      hash: computedHash,
      sizeBytes,
      lastAccess: Date.now(),
    });
    this.totalBytes += sizeBytes;
  }

  has(filePath: string): boolean {
    return this.cache.has(filePath);
  }

  delete(filePath: string): void {
    const entry = this.cache.get(filePath);
    if (entry) {
      this.totalBytes -= entry.sizeBytes;
      this.cache.delete(filePath);
    }
  }

  clear(): void {
    this.cache.clear();
    this.totalBytes = 0;
  }

  size(): number {
    return this.cache.size;
  }

  totalSizeBytes(): number {
    return this.totalBytes;
  }

  stats(): { entries: number; totalBytes: number; hitRate: number } {
    return {
      entries: this.cache.size,
      totalBytes: this.totalBytes,
      hitRate: 0,
    };
  }

  private evictOldest(): void {
    const firstKey = this.cache.keys().next().value;
    if (firstKey !== undefined) {
      const entry = this.cache.get(firstKey)!;
      this.totalBytes -= entry.sizeBytes;
      this.cache.delete(firstKey);
    }
  }
}

export const fileContentCache = new FileContentCache();
