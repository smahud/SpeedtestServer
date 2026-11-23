/** Count decoded scalar form bytes without decoding them as UTF-8 or retaining values. */
export class PhpFormCounter {
  private fields = new Map<string, number>();
  private key: number[] = [];
  private valueBytes = 0;
  private inValue = false;
  private escape: number[] = [];
  private seen = 0;
  private hex(byte: number): number {
    if (byte >= 48 && byte <= 57) return byte - 48;
    if (byte >= 65 && byte <= 70) return byte - 55;
    if (byte >= 97 && byte <= 102) return byte - 87;
    return -1;
  }
  private emit(byte: number): void {
    if (this.inValue) this.valueBytes++;
    else {
      if (this.key.length >= 1024) throw new Error('Form field name exceeds 1024 bytes');
      this.key.push(byte);
    }
  }
  private flushEscape(): void {
    for (const byte of this.escape) this.emit(byte);
    this.escape = [];
  }
  private consume(byte: number): void {
    if (this.escape.length) {
      const digit = this.hex(byte);
      if (digit >= 0) {
        if (this.escape.length === 1) this.escape.push(byte);
        else {
          this.emit((this.hex(this.escape[1]) << 4) | digit);
          this.escape = [];
        }
        return;
      }
      this.flushEscape();
    }
    if (byte === 37) this.escape = [byte];
    else this.emit(byte === 43 ? 32 : byte);
  }
  private endField(): void {
    this.flushEscape();
    const name = Buffer.from(this.key).toString('latin1').split('\0',1)[0].replace(/^ +/, '').replace(/[ .]/g, '_');
    if (name && this.seen++ < 1000) this.fields.set(name, this.valueBytes);
    this.key = [];
    this.valueBytes = 0;
    this.inValue = false;
  }
  write(chunk: Buffer): void {
    for (const byte of chunk) {
      if (byte === 38) this.endField();
      else if (byte === 61 && !this.inValue) {
        this.flushEscape(); this.inValue = true;
      } else this.consume(byte);
    }
  }
  finish(): void { this.endField(); }
  size(): number {
    let size = 500;
    // latin1 keys preserve PHP strlen byte counts, including non-UTF-8 names.
    for (const [name, bytes] of this.fields) size += name.length + bytes + 3;
    return size;
  }
}
