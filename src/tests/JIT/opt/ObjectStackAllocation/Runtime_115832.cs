// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

// Generated by Fuzzlyn v3.0 on 2025-05-20 22:26:35
// Run on X64 Windows
// Seed: 457555340882575514-vectort,vector128,vector256,x86aes,x86avx,x86avx2,x86avx512bw,x86avx512bwvl,x86avx512cd,x86avx512cdvl,x86avx512dq,x86avx512dqvl,x86avx512f,x86avx512fvl,x86avx512fx64,x86bmi1,x86bmi1x64,x86bmi2,x86bmi2x64,x86fma,x86lzcnt,x86lzcntx64,x86pclmulqdq,x86popcnt,x86popcntx64,x86sse,x86ssex64,x86sse2,x86sse2x64,x86sse3,x86sse41,x86sse41x64,x86sse42,x86sse42x64,x86ssse3,x86x86base
// Reduced from 154.0 KiB to 0.8 KiB in 00:06:12
// Hits JIT assert in Release:
// Assertion failed 'm_blockLayout->CanAssignFrom(m_src->GetLayout(m_comp))' in 'Program:Main(Fuzzlyn.ExecutionServer.IRuntime)' during 'Morph - Global' (IL size 69; hash 0xade6b36b; FullOpts)
// 
//     File: D:\a\_work\1\s\src\coreclr\jit\morphblock.cpp Line: 668
// 
using System;
using Xunit;

public class C0
{
}

public struct S0
{
    public int F5;
}

public struct S1
{
    public C0 F2;
    public S0 F3;
    public S1(C0 f2) : this()
    {
        F2 = f2;
    }
}

public struct S2
{
    public S1 F5;
    public S1 F7;
    public S2(S1 f5) : this()
    {
        F5 = f5;
    }
}

public struct S4
{
    public S2 F1;
    public S4(S2 f1) : this()
    {
        F1 = f1;
    }
}

public struct S5
{
    public S4 F5;
    public S5(S4 f5) : this()
    {
        F5 = f5;
    }
}

public class Runtime_115832
{
    [Fact]
    public static void Problem()
    {
        S5 vr0 = new S5(new S4(new S2(new S1(new C0()))));
        System.Console.WriteLine(vr0.F5.F1.F7.F3.F5);
    }
}