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
