//extern "C" void CallCountingStubCode();

__cdecl void CallCountingStubCode()
{
    _ASSERTE("CallCountingStubCode is not implemented on wasm");
}

UINT_PTR STDCALL GetCurrentIP(void)
{
    _ASSERTE("GetCurrentIP is not implemented on wasm");
    return 0;
}
