# Method 5: Ghidra Decompilation Analysis (Extended Run)

## Binary Information
- **File**: OoklaServer-linux-x86_64
- **SHA256**: f19e5ed240dc185bcaf6ca96e0fa40d5ee53e3a543f4c562082ac0d8d92f027a
- **Tool**: Ghidra 12.1.4 (headless analyzer)
- **Run Time**: ~2 hours (timeout at 7200s)

## Analysis Results

### Status: **Partial Completion - Timeout**
The Ghidra analysis ran for 2 hours but timed out before completing full decompilation of all functions.

### What Was Achieved:
1. **Project Creation**: Successful
2. **Binary Import**: Successful (15.5 MB ELF64)
3. **Auto-Analysis**: Started and ran extensively
4. **Function Discovery**: Ghidra identified thousands of functions
5. **Decompilation Started**: Began decompiling functions but incomplete

### Issues Encountered:
1. **Massive C++ Exception Handling**: Hundreds of "Failed to disassemble" errors from GccExceptionAnalyzer
2. **Stripped Binary**: No symbols to guide analysis
3. **Static Linking**: All library code embedded (~3000+ functions estimated)
4. **Template Bloat**: Heavy C++ template usage creates many similar functions
5. **Constructor Resolution**: Thousands of "Unable to resolve constructor" warnings

### Decompilation Statistics (from log):
- **Functions with warnings**: 1000+ functions showing decompilation issues
- **Common errors**: 
  - "Unable to resolve constructor at <address>"
  - "Failed to resolve varnode <Sreg>, index=6/7"
  - "Could not follow disassembly flow into non-existing memory"

### Functions Likely Identified (from init_array analysis):
From GDB analysis of .init_array (133 entries), key constructor functions include:
- `0x294eb0` - First constructor (references 0x10d42a0)
- `0x294f90` - Second constructor (references 0x10d42e0)
- `0x295020` - Third constructor (references 0x10d43a0)
- `0x29fea0` - Checks 0x109c690, calls 0xb445f0
- `0x29fb80` - Last constructor (initializes bytes at 0x10de300-0x10de318)

### Key Function at 0xb445f0:
- Appears to be a **singleton/initialization pattern**
- Tests `rdi` (pointer), reads dword, branches on zero
- Initializes structure at `rsi` with:
  - `QWORD [rsi] = -1`
  - `QWORD [rsi+8] = 0`
  - `QWORD [rsi+10] = 0`
  - `QWORD [rsi+18] = rdi`
  - `QWORD [rsi+20] = 0x7f8` (2040)
- Calls `0xb52af5` and `0xb52ebc` (likely library init)
- Sets up global at `0x10de5b8`

### Recommendations for Complete Analysis:
1. **Use Ghidra GUI** for interactive analysis of key functions
2. **Focus on entry point tracing** (0x29fc35 → init_array → main)
3. **Use FunctionID** with Boost/POCO/OpenSSL signatures
4. **Target specific addresses**: 0x29fc35, 0x29fea0, 0xb445f0, 0xb52af5, 0xb52ebc
5. **Extend timeout** to 4+ hours with 16GB+ heap for full decompilation

### Comparison with Other Methods:
| Aspect | objdump | readelf | GDB | Ghidra (partial) |
|--------|---------|---------|-----|------------------|
| Entry point disasm | Raw | N/A | ✅ Annotated | N/A |
| Init array analysis | N/A | N/A | ✅ 133 funcs | N/A |
| Function boundaries | Manual | N/A | N/A | Auto (incomplete) |
| Decompilation | No | No | No | Started |
| Type recovery | No | No | No | Attempted |

## Conclusion
Ghidra analysis **partially successful** but requires more time. The binary's stripped, static nature with massive C++ exception handling makes automated analysis extremely slow. Manual/interactive Ghidra analysis of the entry point and init_array functions is the most productive path forward.
