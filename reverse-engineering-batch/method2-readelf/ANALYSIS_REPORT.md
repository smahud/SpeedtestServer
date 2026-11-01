# Method 2: readelf Comprehensive ELF Analysis

## Binary Information
- **File**: OoklaServer-linux-x86_64
- **SHA256**: f19e5ed240dc185bcaf6ca96e0fa40d5ee53e3a543f4c562082ac0d8d92f027a
- **Format**: ELF64 (x86-64)
- **Type**: DYN (Position-Independent Executable)
- **Entry Point**: 0x29fc35
- **Size**: 15,550,832 bytes

## ELF Header
```
Magic: 7f 45 4c 46 02 01 01 00 00 00 00 00 00 00 00 00
Class: ELF64
Data: 2's complement, little endian
Version: 1 (current)
OS/ABI: UNIX - System V
ABI Version: 0
Type: DYN (Position-Independent Executable)
Machine: Advanced Micro Devices X86-64
Version: 0x1
Entry: 0x29fc35
Program headers: 64 bytes into file, 11 headers, 56 bytes each
Section headers: 15,549,104 bytes into file, 27 headers, 64 bytes each
Section header string table index: 26
Flags: 0x0
```

## Program Headers (11 total)
| Type | Offset | VirtAddr | PhysAddr | FileSiz | MemSiz | Flags | Align |
|------|--------|----------|----------|---------|--------|-------|-------|
| LOAD | 0x0 | 0x0 | 0x0 | 0xe8d70 | 0xe8d70 | R | 0x200000 |
| LOAD | 0x200000 | 0x200000 | 0x200000 | 0x95bda8 | 0x95bda8 | R E | 0x200000 |
| LOAD | 0xc00000 | 0xc00000 | 0xc00000 | 0x1ff12c | 0x1ff12c | R | 0x200000 |
| LOAD | 0xdff2b0 | 0xfff2b0 | 0xfff2b0 | 0xd4ef0 | 0xe1018 | RW | 0x200000 |
| DYNAMIC | 0xe9c140 | 0x109c140 | 0x109c140 | 0x1a0 | 0x1a0 | RW | 0x8 |
| NOTE | 0x2a8 | 0x2a8 | 0x2a8 | 0x20 | 0x20 | R | 0x8 |
| TLS | 0xdff2b0 | 0xfff2b0 | 0xfff2b0 | 0x0 | 0x10 | R | 0x8 |
| GNU_PROPERTY | 0x2a8 | 0x2a8 | 0x2a8 | 0x20 | 0x20 | R | 0x8 |
| GNU_EH_FRAME | 0xcfcdc4 | 0xcfcdc4 | 0xcfcdc4 | 0x23b3c | 0x23b3c | R | 0x4 |
| GNU_STACK | 0x0 | 0x0 | 0x0 | 0x0 | 0x0 | RW | 0x10 |
| GNU_RELRO | 0xdff2b0 | 0xfff2b0 | 0xfff2b0 | 0x9dd50 | 0x9dd50 | R | 0x1 |

## Section to Segment Mapping
- Segment 00: .note.gnu.property .hash .gnu.hash .dynsym .dynstr .rela.dyn
- Segment 01: .init .plt .plt.sec .text .fini
- Segment 02: .rodata .eh_frame_hdr .eh_frame .gcc_except_table
- Segment 03: .init_array .fini_array .data.rel.ro .dynamic .got .data .saltblk .bss
- Segment 04: .dynamic
- Segment 05: .note.gnu.property
- Segment 06: .tbss
- Segment 07: .note.gnu.property
- Segment 08: .eh_frame_hdr
- Segment 10: .init_array .fini_array .data.rel.ro .dynamic .got

## Dynamic Section (22 entries)
- SYMBOLIC: 0x0
- INIT: 0x200000
- FINI: 0xb5bda5
- INIT_ARRAY: 0xfff2b0 (1064 bytes)
- FINI_ARRAY: 0xfff6d8 (8 bytes)
- HASH: 0x2c8
- GNU_HASH: 0x2d8
- STRTAB: 0x310
- SYMTAB: 0x2f8
- STRSZ: 1 byte
- SYMENT: 24 bytes
- DEBUG: 0x0
- PLTGOT: 0x109c2e0
- RELA: 0x318
- RELASZ: 952,920 bytes
- RELAENT: 24 bytes
- BIND_NOW: (flag)
- FLAGS_1: NOW NODUMP PIE
- RELACOUNT: 39,705

## Symbol Tables
- **.dynsym**: 1 entry (NULL entry only - binary is stripped)
- **Symbol table (.symtab)**: Not present (stripped binary)

## Relocations (.rela.dyn)
- **Total entries**: 39,705
- **Size**: 952,920 bytes
- **Type**: All R_X86_64_RELATIVE (relative relocations)
- **Purpose**: PIE base address adjustment

## Security Features
1. **PIE (Position Independent Executable)**: Enabled
2. **BIND_NOW**: Enabled (immediate binding)
3. **RELRO**: Full RELRO (GNU_RELRO segment present)
4. **Stack Protection**: RW GNU_STACK (no NX stack)
5. **Fortify Source**: Not directly detectable
6. **Statically Linked**: No external library dependencies

## Key Observations
1. **Completely Stripped**: No symbol table, only 1 dynamic symbol (NULL)
2. **Statically Linked**: All dependencies included in binary
3. **PIE**: Position Independent Executable for ASLR
4. **C++ Exception Handling**: Extensive .eh_frame and .gcc_except_table
5. **Large Relocation Table**: 39,705 entries for PIE support
6. **Thread Local Storage**: .tbss section present (16 bytes)
7. **Custom Section**: .saltblk (96 bytes) - likely for key/salt storage

## File Sizes
- full_analysis.txt: 2,834,046 bytes
- relocations.txt: 2,824,926 bytes
- symbols.txt: 166 bytes
- dyn_symbols.txt: 166 bytes
