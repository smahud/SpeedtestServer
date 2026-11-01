# Method 4: Dynamic Linking & Symbol Analysis (nm, objdump, ldd)

## Binary Information
- **File**: OoklaServer-linux-x86_64
- **SHA256**: f19e5ed240dc185bcaf6ca96e0fa40d5ee53e3a543f4c562082ac0d8d92f027a

## Dynamic Dependencies (ldd)
```
statically linked
```
**Result**: No dynamic dependencies - fully statically linked executable.

## Dynamic Symbols (objdump -T)
```
OoklaServer-linux-x86_64:     file format elf64-x86-64

DYNAMIC SYMBOL TABLE:
no symbols
```

## Dynamic Symbols (nm -D)
```
(no output - no dynamic symbols)
```

## Readelf Dynamic Symbols (readelf --dyn-syms)
```
Symbol table '.dynsym' contains 1 entry:
   Num:    Value          Size Type    Bind   Vis      Ndx Name
     0: 0000000000000000     0 NOTYPE  LOCAL  DEFAULT  UND 
```

## Symbol Table (readelf -s)
```
Symbol table '.dynsym' contains 1 entry:
   Num:    Value          Size Type    Bind   Vis      Ndx Name
     0: 0000000000000000     0 NOTYPE  LOCAL  DEFAULT  UND 
```

## Relocations (readelf -r)
- **Section**: .rela.dyn
- **Entries**: 39,705
- **Size**: 952,920 bytes
- **Type**: All R_X86_64_RELATIVE

### Sample Relocations (first 50)
```
Offset             Info           Type           Sym. Value    Symbol Name + Addend
000000fff2b0  000000000008 R_X86_64_RELATIVE                    29fea0
000000fff2b8  000000000008 R_X86_64_RELATIVE                    294e60
000000fff2c0  000000000008 R_X86_64_RELATIVE                    294eb0
000000fff2c8  000000000008 R_X86_64_RELATIVE                    294f90
000000fff2d0  000000000008 R_X86_64_RELATIVE                    294fd0
...
```
All relocations are relative (adjusting addresses for PIE base).

## Key Observations
1. **No Dynamic Symbols**: Binary has no exported dynamic symbols
2. **No Dynamic Dependencies**: Completely self-contained static binary
3. **PIE Relocations Only**: All 39,705 relocations are for PIE base adjustment
4. **Stripped**: No symbol table (.symtab) present
5. **No PLT/GOT Entries**: Minimal PLT (0x90 bytes) - only for internal calls

## Comparison with Typical Dynamic Binary
| Feature | OoklaServer | Typical Dynamic Binary |
|---------|-------------|------------------------|
| Dynamic Deps | None | libc, libstdc++, etc. |
| Dynamic Symbols | 1 (NULL) | Hundreds |
| Relocations | 39,705 (RELATIVE) | Mixed (GLOB_DAT, JUMP_SLOT, RELATIVE) |
| PLT Size | 144 bytes | Thousands of bytes |
| GOT Size | 3,352 bytes | Larger |

## Conclusion
This is a **fully statically linked, stripped, position-independent executable** with:
- All C/C++ standard library code embedded
- All Boost/POCO/OpenSSL code embedded
- Only PIE relocations for ASLR support
- No external runtime dependencies
