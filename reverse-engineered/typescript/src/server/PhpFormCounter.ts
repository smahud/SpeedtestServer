/**
 * PhpFormCounter — byte-exact emulation of PHP's form/query variable parsing
 * as consumed by the official 2007 Ookla `speedtest/upload.php`
 * (`$size = 500; foreach ($_REQUEST as $k => $v) $size += strlen($k) + strlen($v) + 3`).
 *
 * Every rule below was differential-verified against PHP 8.4 CLI running the
 * unmodified official script (oracle matrix in
 * validation/HTTP_UPLOAD_PHP_PARITY_2026-11-23.md):
 *   - `%XX` and `+` decoding, byte (not UTF-8 codepoint) lengths;
 *   - variable-name mangling: cut at NUL, strip leading spaces, spaces/dots → `_`;
 *   - empty names (after mangling, or `[...]` with an empty base) are dropped;
 *   - duplicate names: the LAST value wins (no extra variable slot consumed);
 *   - max_input_vars (default 1000) keeps the first 1001 distinct variables —
 *     verified empirically: f0..f1000 are kept, f1001+ are dropped, and 1001
 *     duplicate writes of one name do NOT consume slots;
 *   - no key-length limit (a 2000-byte key counts in full);
 *   - array syntax (`name[...]` with a closing bracket and non-empty base)
 *     builds an array value: `strlen()` on it is fatal in PHP 8 → HTTP 500.
 *
 * `request_order` is "GP" (PHP default, verified): $_REQUEST = GET ∪ POST with
 * POST overriding GET per key; see `mergedSize`.
 */
export class PhpFormCounter {
  private fields = new Map<string, number>();
  private arrays = new Set<string>();
  // BUG FIX (memory amplification): the key used to accumulate as number[]
  // (~4× the byte count in heap per request — an 8 MiB keyless body meant
  // ~33 MB of Smi array elements, ×64 concurrent requests ≈ 2 GB). V8
  // one-byte (latin1) strings store exactly 1 byte per char — same semantics,
  // a quarter of the footprint.
  private key = '';
  private valueBytes = 0;
  private inValue = false;
  private escape: number[] = [];
  private seen = 0;

  /** PHP keeps exactly the first 1001 distinct variables (max_input_vars=1000, off-by-one verified). */
  static readonly MAX_VARS = 1001;

  private hex(byte: number): number {
    if (byte >= 48 && byte <= 57) return byte - 48;
    if (byte >= 65 && byte <= 70) return byte - 55;
    if (byte >= 97 && byte <= 102) return byte - 87;
    return -1;
  }

  private emit(byte: number): void {
    if (this.inValue) this.valueBytes++;
    else this.key += String.fromCharCode(byte); // latin1 one-byte string
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

  /** PHP variable-name mangling (php_register_variable_ex). */
  static mangle(raw: string): string {
    return raw.split('\0', 1)[0].replace(/^ +/, '').replace(/[ .]/g, '_');
  }

  /** Register one parsed field (decoded name, raw value byte length). */
  addField(rawName: string, valueBytes: number): void {
    const name = PhpFormCounter.mangle(rawName);
    if (!name) return; // empty name → PHP drops the variable entirely
    const open = name.indexOf('[');
    if (open === 0) return; // "[x]=1": empty base name → dropped
    if (open > 0 && name.indexOf(']', open) !== -1) {
      // Array value: strlen() on an array is a fatal TypeError in PHP 8.
      this.arrays.add(name.slice(0, open));
      return;
    }
    if (this.fields.has(name)) {
      this.fields.set(name, valueBytes); // overwrite, no new variable slot
      return;
    }
    if (this.seen >= PhpFormCounter.MAX_VARS) return; // dropped beyond the cap
    this.seen++;
    this.fields.set(name, valueBytes);
  }

  private endField(): void {
    this.flushEscape();
    // this.key is already a latin1 string — PHP strlen() byte counts preserved.
    this.addField(this.key, this.valueBytes);
    this.key = '';
    this.valueBytes = 0;
    this.inValue = false;
  }

  write(chunk: Buffer): void {
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i];
      if (byte === 38) this.endField();
      else if (byte === 61 && !this.inValue) {
        this.flushEscape();
        this.inValue = true;
      } else this.consume(byte);
    }
  }

  finish(): void {
    this.endField();
  }

  /** 500 + Σ(strlen(key)+strlen(value)+3) over this pass's scalar fields. */
  size(): number {
    let size = 500;
    // latin1 keys preserve PHP strlen byte counts, including non-UTF-8 names.
    for (const [name, bytes] of this.fields) size += name.length + bytes + 3;
    return size;
  }

  /** True when any variable in this pass ends up holding an array value. */
  hasArrayValue(): boolean {
    return this.arrays.size > 0;
  }

  /**
   * request_order="GP" merge: the POST pass (`this`) overrides the GET pass
   * per key. Returns the upload.php size, or -1 when any final value is an
   * array (PHP 8 strlen() fatal → the script dies with HTTP 500).
   */
  mergedSize(getPass: PhpFormCounter): number {
    let fatal = false;
    let size = 500;
    // Array-valued keys live in `arrays`, not `fields`; they must join the
    // key set so a surviving GET array (POST did not override it) still
    // triggers the strlen() fatal (regression found 2026-11-23).
    const keys = new Set<string>([
      ...getPass.fields.keys(),
      ...this.fields.keys(),
      ...getPass.arrays,
      ...this.arrays,
    ]);
    for (const key of keys) {
      if (this.arrays.has(key)) {
        fatal = true; // POST re-registered the key as an array
        continue;
      }
      if (this.fields.has(key)) {
        size += key.length + (this.fields.get(key) as number) + 3;
        continue;
      }
      if (getPass.arrays.has(key)) {
        fatal = true; // GET array survives (POST did not override it)
        continue;
      }
      if (getPass.fields.has(key)) size += key.length + (getPass.fields.get(key) as number) + 3;
    }
    return fatal ? -1 : size;
  }
}
