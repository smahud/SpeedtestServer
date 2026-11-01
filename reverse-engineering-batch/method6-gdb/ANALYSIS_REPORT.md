# Method 6: GDB Static Analysis

## Binary Information
- **File**: OoklaServer-linux-x86_64
- **SHA256**: f19e5ed240dc185bcaf6ca96e0fa40d5ee53e3a543f4c562082ac0d8d92f027a
- **Tool**: GDB (GNU Debugger)

## GDB Analysis Approach
Since the binary is stripped and statically linked, GDB static analysis focuses on:
1. Examining entry point and initialization
2. Analyzing .init_array/.fini_array
3. Inspecting memory layout
4. Finding main function through entry point tracing

## Entry Point Analysis
```
Entry point: 0x29fc35
```

### GDB Commands for Analysis
```bash
gdb -q /root/project/OoklaServer/OoklaServer-linux-x86_64
(gdb) info files
(gdb) info functions
(gdb) disas /r _start
(gdb) disas /r main
(gdb) info registers
(gdb) x/50i 0x29fc35
```

## Expected Findings

### 1. Entry Point (_start)
- Standard glibc startup sequence
- Stack setup
- .init_array iteration (1064 bytes = 133 function pointers)
- Call to __libc_start_main
- Main function identification

### 2. Init Array (.init_array)
- **Location**: 0xfff2b0 (file offset 0xdff2b0)
- **Size**: 1064 bytes (133 entries × 8 bytes)
- **Purpose**: C++ static initialization
- **Contains**: Pointers to global constructors

### 3. Fini Array (.fini_array)
- **Location**: 0xfff6d8 (file offset 0xdff6d8)
- **Size**: 8 bytes (1 entry)
- **Purpose**: C++ static destruction

### 4. Main Function
- Likely at one of the .init_array entries
- Or called from __libc_start_main
- Expected to be large (manages multi-process architecture)

## Memory Layout (from readelf)
```
0x000000 - 0x0e8d70: Read-only data (headers, .rela.dyn, .dynsym, etc.)
0x200000 - 0xb5bda8: Code (.text, .plt, .init, .fini) - RX
0xc00000 - 0xdff12c: Read-only data (.rodata, .eh_frame) - R
0xfff2b0 - 0x10d41c0: Read-write data (.data, .bss, .got) - RW
```

## Thread Local Storage
- **.tbss**: 16 bytes at 0xfff2b0
- **TLS Segment**: Present in program headers

## Exception Handling
- **.eh_frame_hdr**: 0x23b3c bytes at 0xcfcdc4
- **.eh_frame**: 0xa11a4 bytes at 0xd20900
- **.gcc_except_table**: 0x3d688 bytes at 0xdc1aa4

## GDB Limitations for Static Analysis
1. **No Symbols**: Cannot set breakpoints by name
2. **Stripped**: No function names
3. **Static**: No dynamic loader interaction
4. **Large**: 15.5 MB code section slows analysis

## Recommended GDB Workflow
1. `set disassembly-flavor intel`
2. `info files` - confirm memory layout
3. `disas /r 0x29fc35` - analyze entry point
4. `x/133xg 0xfff2b0` - dump .init_array
5. Trace through to find main
6. Analyze key functions at identified addresses

## Key Addresses for Manual Analysis
| Address | Purpose |
|---------|---------|
| 0x29fc35 | Entry point (_start) |
| 0xfff2b0 | .init_array (133 constructors) |
| 0x200140 | .text section start |
| 0xb5bda5 | .fini section |
| 0xc00000 | .rodata section |
| 0x109c2e0 | .got (Global Offset Table) |
| 0x109c140 | .dynamic section |

## Conclusion
GDB static analysis on this binary is limited by the stripped nature. The most valuable approach is tracing from the entry point through .init_array to identify the main application logic. Dynamic analysis (running under GDB) would be more productive but requires the server environment.
