//extern "C" void CallCountingStubCode();

__cdecl void CallCountingStubCode()
{
    PORTABILITY_ASSERT("CallCountingStubCode is not implemented on wasm");
}

UINT_PTR STDCALL GetCurrentIP(void)
{
    PORTABILITY_ASSERT("GetCurrentIP is not implemented on wasm");
    return 0;
}
