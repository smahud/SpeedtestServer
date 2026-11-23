import { PhpFormCounter } from './PhpFormCounter';

describe('streaming PHP scalar form byte accounting', () => {
  test.each([['content1=abc',514],['content1=a%FF',513],['a=%C3%A9',506],['a=hello+world',515],['a=old&a=new&b=',511],['',500],['=ignored',500],['a=%Q1',507],['a=%A',506]])('%s → %i', (input, expected) => {
    const counter = new PhpFormCounter();
    for (const byte of Buffer.from(input)) counter.write(Buffer.from([byte]));
    counter.finish();
    expect(counter.size()).toBe(expected);
  });
  test('large fields retain counts rather than their values', () => {
    const counter = new PhpFormCounter();
    counter.write(Buffer.from('content1='));
    const chunk = Buffer.alloc(65536,97);
    for (let i=0;i<32;i++) counter.write(chunk);
    counter.finish();
    expect(counter.size()).toBe(500+8+2097152+3);
  });
});

/** Verified against PHP 8.4 CLI executing the official 2007 Ookla upload.php
 *  (oracle matrix: validation/HTTP_UPLOAD_PHP_PARITY_2026-11-23.md). */
describe('PHP 8 $_REQUEST semantics (oracle-verified 2026-11-23)', () => {
  const run = (input: string): PhpFormCounter => {
    const counter = new PhpFormCounter();
    counter.write(Buffer.from(input));
    counter.finish();
    return counter;
  };

  test('no variable-name length limit (2000-byte key counts in full)', () => {
    expect(run('k'.repeat(2000) + '=v').size()).toBe(500 + 2000 + 1 + 3);
  });

  test('empty names and empty-base array names are dropped', () => {
    expect(run('=value').size()).toBe(500);
    expect(run('[x]=1').size()).toBe(500);
  });

  test('bracket without closing bracket stays a scalar name', () => {
    expect(run('a[=1').size()).toBe(500 + 2 + 1 + 3);
    expect(run('a]=1').size()).toBe(500 + 2 + 1 + 3);
  });

  test('array syntax is detected and flagged (strlen() fatal in PHP 8)', () => {
    expect(run('a[]=1').hasArrayValue()).toBe(true);
    expect(run('a[x][y]=1').hasArrayValue()).toBe(true);
    expect(run('a[b]c=1').hasArrayValue()).toBe(true);
    expect(run('a[xxxxxxxxxx]=1').hasArrayValue()).toBe(true);
    expect(run('a=1').hasArrayValue()).toBe(false);
  });

  test('max_input_vars keeps the first 1001 distinct variables', () => {
    const fields: string[] = [];
    for (let i = 0; i < 1200; i++) fields.push(`f${i}=`);
    const counter = run(fields.join('&'));
    let expected = 500;
    for (let i = 0; i <= 1000; i++) expected += `f${i}`.length + 0 + 3;
    expect(counter.size()).toBe(expected);
  });

  test('duplicate writes do not consume variable slots', () => {
    const parts: string[] = [];
    for (let i = 0; i < 1001; i++) parts.push('a=1');
    parts.push('b=2');
    expect(run(parts.join('&')).size()).toBe(500 + (1 + 1 + 3) * 2);
  });

  test('request_order=GP merge: POST overrides GET per key, arrays survive fatally', () => {
    const get = run('content1=GETVAL&z=9');
    const post = run('content1=POSTVAL');
    expect(post.mergedSize(get)).toBe(500 + (8 + 7 + 3) + (1 + 1 + 3));
    // GET array survives when POST does not override the key.
    const getArray = run('a[x]=1');
    expect(run('b=2').mergedSize(getArray)).toBe(-1);
    // POST array wins over a GET scalar.
    expect(run('a[x]=2').mergedSize(run('a=1'))).toBe(-1);
    // POST scalar overrides a GET array: no fatal.
    expect(run('a=2').mergedSize(getArray)).toBe(500 + 1 + 1 + 3);
  });

  test('100-field hosted-tester upload shape matches the official verdicts', () => {
    // Wire 515699 → PHP 516300; wire 1980899 → PHP 1981500 (see
    // validation/HTTP_UPLOAD_PHP_PARITY_2026-11-23.md for the 601-byte
    // PHP-vs-daemon derivation from the two published Ookla tester results).
    const build = (wire: number): string => {
      const parts: string[] = [];
      let budget = wire - 199 - (8 * 9 + 9 * 90 + 10);
      for (let i = 1; i <= 100; i++) {
        const vlen = Math.floor(budget / (101 - i));
        budget -= vlen;
        parts.push(`content${i}=` + 'a'.repeat(vlen));
      }
      return parts.join('&');
    };
    const upload = run(build(515699));
    expect(Buffer.byteLength(build(515699))).toBe(515699);
    expect(upload.size()).toBe(516300);
    const max = run(build(1980899));
    expect(max.size()).toBe(1981500);
  });
});
