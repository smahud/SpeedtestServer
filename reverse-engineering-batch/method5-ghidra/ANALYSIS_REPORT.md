# Method 5: Ghidra Decompilation Analysis

## Binary Information
- **File**: OoklaServer-linux-x86_64
- **SHA256**: f19e5ed240dc185bcaf6ca96e0fa40d5ee53e3a543f4c562082ac0d8d92f027a
- **Tool**: Ghidra 12.1.4 (headless analyzer)

## Analysis Attempt
- **Status**: Timeout during analysis (5+ minutes)
- **Script**: Custom DecompileAll.java script
- **Java**: OpenJDK 17
- **Errors**: Multiple "Failed to disassemble" errors from GccExceptionAnalyzer

## Ghidra Analysis Challenges
1. **Large Binary**: 15.5 MB stripped static binary
2. **C++ Exception Handling**: Extensive .eh_frame/.gcc_except_table causing GccExceptionAnalyzer errors
3. **Stripped Symbols**: No function names or symbols to guide analysis
4. **Static Linking**: All library code embedded, massive function count
5. **Templates/Virtual Functions**: Heavy C++ template usage creates many similar functions

## Expected Ghidra Outputs (if completed)
1. **Function List**: 3000+ functions (estimated)
2. **Decompiled C Code**: Pseudo-C for each function
3. **Type Recovery**: C++ class hierarchies, vtables
4. **Cross-References**: Call graph, data references
5. **String References**: All string usage locations

## Partial Results from Ghidra Launch
- Project created successfully
- Binary imported and analyzed (auto-analysis started)
- Decompiler initialized
- Script execution began but timed out

## Alternative: Use Ghidra GUI for Interactive Analysis
For future analysis, recommend:
1. Use Ghidra GUI with longer timeout
2. Focus on entry point and main functions first
3. Use FunctionID to identify library functions
4. Apply C++ RTTI analysis for class recovery

## Comparison with Other Methods
| Aspect | objdump | readelf | Ghidra (expected) |
|--------|---------|---------|-------------------|
| Disassembly | Raw assembly | N/A | Annotated assembly |
| Decompilation | No | No | Yes (pseudo-C) |
| Function Detection | Basic | No | Advanced (ML-based) |
| Type Recovery | No | No | Yes (C++ classes) |
| Call Graph | Manual | No | Automated |
| Cross-Refs | Manual | No | Full graph |

## Recommendation
Ghidra analysis requires significant time (30+ minutes) for a binary this size. For production analysis:
1. Use Ghidra with FunctionID database for library identification
2. Focus on specific areas (entry, network, crypto)
3. Export decompilation for key functions only
4. Use headless with longer timeout and more memory
