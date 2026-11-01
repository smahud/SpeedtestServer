# Method 1: objdump Disassembly Analysis

## Binary Information
- **File**: OoklaServer-linux-x86_64
- **SHA256**: f19e5ed240dc185bcaf6ca96e0fa40d5ee53e3a543f4c562082ac0d8d92f027a
- **Format**: ELF 64-bit LSB executable, x86-64
- **Size**: 15,550,832 bytes (~15.5 MB)
- **Entry Point**: 0x29fc35
- **Architecture**: i386:x86-64
- **Flags**: HAS_SYMS, DYNAMIC, D_PAGED

## Section Layout
| Idx | Name | Size | VMA | File Offset | Flags |
|-----|------|------|-----|-------------|-------|
| 0 | .note.gnu.property | 0x20 | 0x2a8 | 0x2a8 | CONTENTS, ALLOC, LOAD, READONLY, DATA |
| 1 | .hash | 0x10 | 0x2c8 | 0x2c8 | CONTENTS, ALLOC, LOAD, READONLY, DATA |
| 2 | .gnu.hash | 0x1c | 0x2d8 | 0x2d8 | CONTENTS, ALLOC, LOAD, READONLY, DATA |
| 3 | .dynsym | 0x18 | 0x2f8 | 0x2f8 | CONTENTS, ALLOC, LOAD, READONLY, DATA |
| 4 | .dynstr | 0x1 | 0x310 | 0x310 | CONTENTS, ALLOC, LOAD, READONLY, DATA |
| 5 | .rela.dyn | 0xe8a58 | 0x318 | 0x318 | CONTENTS, ALLOC, LOAD, READONLY, DATA |
| 6 | .init | 0x8 | 0x200000 | 0x200000 | CONTENTS, ALLOC, LOAD, READONLY, CODE |
| 7 | .plt | 0x90 | 0x200010 | 0x200010 | CONTENTS, ALLOC, LOAD, READONLY, CODE |
| 8 | .plt.sec | 0x80 | 0x2000a0 | 0x2000a0 | CONTENTS, ALLOC, LOAD, READONLY, CODE |
| 9 | .text | 0x95bc65 | 0x200140 | 0x200140 | CONTENTS, ALLOC, LOAD, READONLY, CODE |
| 10 | .fini | 0x3 | 0xb5bda5 | 0xb5bda5 | CONTENTS, ALLOC, LOAD, READONLY, CODE |
| 11 | .rodata | 0xfcdc4 | 0xc00000 | 0xc00000 | CONTENTS, ALLOC, LOAD, READONLY, DATA |
| 12 | .eh_frame_hdr | 0x23b3c | 0xcfcdc4 | 0xcfcdc4 | CONTENTS, ALLOC, LOAD, READONLY, DATA |
| 13 | .eh_frame | 0xa11a4 | 0xd20900 | 0xd20900 | CONTENTS, ALLOC, LOAD, READONLY, DATA |
| 14 | .gcc_except_table | 0x3d688 | 0xdc1aa4 | 0xdc1aa4 | CONTENTS, ALLOC, LOAD, READONLY, DATA |
| 15 | .tbss | 0x10 | 0xfff2b0 | 0xdff2b0 | ALLOC, THREAD_LOCAL |
| 16 | .init_array | 0x428 | 0xfff2b0 | 0xdff2b0 | CONTENTS, ALLOC, LOAD, DATA |
| 17 | .fini_array | 0x8 | 0xfff6d8 | 0xdff6d8 | CONTENTS, ALLOC, LOAD, DATA |
| 18 | .data.rel.ro | 0x9ca60 | 0xfff6e0 | 0xdff6e0 | CONTENTS, ALLOC, LOAD, DATA |
| 19 | .dynamic | 0x1a0 | 0x109c140 | 0xe9c140 | CONTENTS, ALLOC, LOAD, DATA |
| 20 | .got | 0xd18 | 0x109c2e0 | 0xe9c2e0 | CONTENTS, ALLOC, LOAD, DATA |
| 21 | .data | 0x37130 | 0x109d000 | 0xe9d000 | CONTENTS, ALLOC, LOAD, DATA |
| 22 | .saltblk | 0x60 | 0x10d4140 | 0xed4140 | CONTENTS, ALLOC, LOAD, DATA |
| 23 | .bss | 0xc108 | 0x10d41c0 | 0xed41a0 | ALLOC |
| 24 | .comment | 0x24 | 0x0 | 0xed41a0 | CONTENTS, READONLY |

## Key Observations
1. **Statically Linked**: No dynamic dependencies (confirmed by ldd)
2. **Large .text section**: ~9.8 MB (0x95bc65) - indicates significant code
3. **Large .rodata section**: ~1 MB (0xfcdc4) - significant read-only data
4. **Large .rela.dyn**: ~952 KB (0xe8a58) - 39,705 relocation entries
5. **C++ Exception Handling**: .eh_frame, .eh_frame_hdr, .gcc_except_table present
6. **No Symbol Table**: Binary is stripped (no .symtab section visible in objdump -t)

## Disassembly Statistics
- **Output size**: 124,556,125 bytes (~125 MB)
- **Entry point**: 0x29fc35
- **Code section (.text)**: 0x200140 - 0xb5bda5 (~9.8 MB)

## Program Headers (from readelf)
- 11 program headers
- 4 LOAD segments (RX, R, RW, R)
- PIE (Position Independent Executable)
- BIND_NOW flag set
- RELRO protection enabled

## Conclusion
This is a stripped, statically linked, position-independent C++ executable with extensive use of C++ exception handling and RTTI. The large code size and relocation count indicate heavy use of templates and virtual functions.
