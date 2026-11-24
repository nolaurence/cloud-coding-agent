import { once } from "node:events";

/** Stay well under V8's ~1 GiB per-string cap. */
export const MAX_SAFE_JSON_STRING = 512 * 1024 * 1024;
const DEFAULT_CHUNK = 1024 * 1024;

export function isInvalidStringLength(error: unknown): boolean {
  return error instanceof RangeError || (error instanceof Error && /Invalid string length/i.test(error.message));
}

/**
 * Encode JSON to a stream without building one giant string.
 * `JSON.stringify` of a 1 GiB workspace snapshot (base64) exceeds V8's string cap.
 */
export async function writeJsonToStream(
  writable: NodeJS.WritableStream,
  value: unknown,
  chunkSize = DEFAULT_CHUNK,
): Promise<void> {
  const size = Number.isInteger(chunkSize) && chunkSize > 0 ? chunkSize : DEFAULT_CHUNK;
  let pending = "";
  const flush = async (force = false) => {
    while (pending.length >= size || (force && pending.length)) {
      const chunk = pending.slice(0, size);
      pending = pending.slice(size);
      if (!writable.write(chunk)) await once(writable, "drain");
    }
  };
  const write = async (text: string) => {
    if (text.length >= size) {
      await flush(true);
      for (let offset = 0; offset < text.length; offset += size) {
        const slice = text.slice(offset, offset + size);
        if (!writable.write(slice)) await once(writable, "drain");
      }
      return;
    }
    pending += text;
    await flush();
  };
  await emitJson(value, write);
  await flush(true);
  await new Promise<void>((resolve, reject) => {
    writable.end((error?: Error | null) => error ? reject(error) : resolve());
  });
}

async function emitJson(value: unknown, write: (text: string) => Promise<void>): Promise<void> {
  if (value === null) {
    await write("null");
    return;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      await write(JSON.stringify(value));
      return;
    case "number":
      await write(Number.isFinite(value) ? JSON.stringify(value) : "null");
      return;
    case "object":
      if (Array.isArray(value)) {
        await write("[");
        for (let index = 0; index < value.length; index++) {
          if (index) await write(",");
          await emitJson(value[index] === undefined ? null : value[index], write);
        }
        await write("]");
        return;
      }
      await write("{");
      let first = true;
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (item === undefined) continue;
        if (!first) await write(",");
        first = false;
        await write(JSON.stringify(key));
        await write(":");
        await emitJson(item, write);
      }
      await write("}");
      return;
    default:
      throw new TypeError("沙箱 JSON 不支持该值类型");
  }
}

/** Parse UTF-8 JSON from a buffer without converting the whole payload into one string. */
export function parseJsonUtf8(buf: Buffer, maxSafeString = MAX_SAFE_JSON_STRING): unknown {
  if (buf.length <= maxSafeString) {
    try {
      return JSON.parse(buf.toString("utf8"));
    } catch (error) {
      if (!isInvalidStringLength(error)) throw error;
    }
  }
  return parseJsonFromBuffer(buf);
}

export function parseJsonFromBuffer(buf: Buffer): unknown {
  const parser = new JsonBufferParser(buf);
  const value = parser.parseValue();
  parser.skipWs();
  if (parser.index !== buf.length) throw new SyntaxError("Unexpected trailing JSON");
  return value;
}

class JsonBufferParser {
  index = 0;
  constructor(private readonly buf: Buffer) {}

  skipWs() {
    const { buf } = this;
    while (this.index < buf.length) {
      const char = buf[this.index]!;
      if (char === 0x20 || char === 0x0a || char === 0x0d || char === 0x09) this.index += 1;
      else break;
    }
  }

  parseValue(): unknown {
    this.skipWs();
    const char = this.buf[this.index];
    if (char === 0x7b) return this.parseObject();
    if (char === 0x5b) return this.parseArray();
    if (char === 0x22) return this.parseString();
    if (char === 0x74) return this.parseLiteral("true", true);
    if (char === 0x66) return this.parseLiteral("false", false);
    if (char === 0x6e) return this.parseLiteral("null", null);
    if (char === 0x2d || (char !== undefined && char >= 0x30 && char <= 0x39)) return this.parseNumber();
    throw new SyntaxError("Unexpected JSON token");
  }

  private parseObject(): Record<string, unknown> {
    this.index += 1;
    const object: Record<string, unknown> = {};
    this.skipWs();
    if (this.buf[this.index] === 0x7d) {
      this.index += 1;
      return object;
    }
    while (this.index < this.buf.length) {
      this.skipWs();
      if (this.buf[this.index] !== 0x22) throw new SyntaxError("Expected JSON object key");
      const key = this.parseString();
      this.skipWs();
      if (this.buf[this.index] !== 0x3a) throw new SyntaxError("Expected ':' in JSON object");
      this.index += 1;
      object[key] = this.parseValue();
      this.skipWs();
      const next = this.buf[this.index];
      if (next === 0x7d) {
        this.index += 1;
        return object;
      }
      if (next !== 0x2c) throw new SyntaxError("Expected ',' or '}' in JSON object");
      this.index += 1;
    }
    throw new SyntaxError("Unterminated JSON object");
  }

  private parseArray(): unknown[] {
    this.index += 1;
    const items: unknown[] = [];
    this.skipWs();
    if (this.buf[this.index] === 0x5d) {
      this.index += 1;
      return items;
    }
    while (this.index < this.buf.length) {
      items.push(this.parseValue());
      this.skipWs();
      const next = this.buf[this.index];
      if (next === 0x5d) {
        this.index += 1;
        return items;
      }
      if (next !== 0x2c) throw new SyntaxError("Expected ',' or ']' in JSON array");
      this.index += 1;
    }
    throw new SyntaxError("Unterminated JSON array");
  }

  private parseString(): string {
    const start = this.index;
    if (this.buf[this.index] !== 0x22) throw new SyntaxError("Expected JSON string");
    this.index += 1;
    while (this.index < this.buf.length) {
      const char = this.buf[this.index]!;
      if (char === 0x5c) {
        this.index += this.index + 1 < this.buf.length ? 2 : 1;
        continue;
      }
      if (char === 0x22) {
        this.index += 1;
        return JSON.parse(this.buf.toString("utf8", start, this.index)) as string;
      }
      this.index += 1;
    }
    throw new SyntaxError("Unterminated JSON string");
  }

  private parseNumber(): number {
    const start = this.index;
    if (this.buf[this.index] === 0x2d) this.index += 1;
    this.consumeDigits();
    if (this.buf[this.index] === 0x2e) {
      this.index += 1;
      this.consumeDigits();
    }
    const exponent = this.buf[this.index];
    if (exponent === 0x65 || exponent === 0x45) {
      this.index += 1;
      const sign = this.buf[this.index];
      if (sign === 0x2b || sign === 0x2d) this.index += 1;
      this.consumeDigits();
    }
    return JSON.parse(this.buf.toString("ascii", start, this.index)) as number;
  }

  private consumeDigits() {
    while (this.index < this.buf.length) {
      const char = this.buf[this.index]!;
      if (char < 0x30 || char > 0x39) break;
      this.index += 1;
    }
  }

  private parseLiteral(expected: string, value: boolean | null): boolean | null {
    const end = this.index + expected.length;
    if (this.buf.toString("ascii", this.index, end) !== expected) throw new SyntaxError("Unexpected JSON token");
    this.index = end;
    return value;
  }
}
