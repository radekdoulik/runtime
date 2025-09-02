#include "gcheaputilities.h"
#include "gcinterface.h"

EXTERN_C ee_alloc_context* GetThreadEEAllocContext();

#define _wasm_Object_m_pMethTab_offset 0
#define _wasm_ArrayBase_m_NumComponents sizeof(Object)
#define _wasm_MethodTable_m_usComponentSize_offset 0 // offsetof(MethodTable, m_dwFlags)
#define SZARRAY_BASE_SIZE sizeof(DWORD) + sizeof(DWORD) // i32 (Object:m_pMethTab) + i32 (ArrayBase: m_NumComponents)
#define SET_FIELD(baseAddr, offset, type, value) *(type*)(((int8_t*)baseAddr) + offset) = (type)value
#define GET_FIELD(baseAddr, offset, type) *(type*)(((int8_t*)baseAddr) + offset)

EXTERN_C FCDECL2(Object*, RhpNewVariableSizeObject, CORINFO_CLASS_HANDLE typeHnd_, INT_PTR size)
{
    PORTABILITY_ASSERT("RhpNewVariableSizeObject is not implemented on wasm");
    return nullptr;
}

static inline Object* _WasmNewArrayFast(CORINFO_CLASS_HANDLE typeHnd_, INT_PTR elementsCount, INT_PTR size)
{
    ee_alloc_context* ctx = GetThreadEEAllocContext();

    if ((INT_PTR)ctx->m_GCAllocContext.alloc_ptr <= INT32_MAX - size && ctx->m_GCAllocContext.alloc_ptr + size <= ctx->m_GCAllocContext.alloc_limit) {
        // allocate the array
        ArrayBase* arr = (ArrayBase*)(ctx->m_GCAllocContext.alloc_ptr);
        ctx->m_GCAllocContext.alloc_ptr += size;

        // set Object:m_pMethTab and ArrayBase:m_NumComponents
        SET_FIELD(arr, _wasm_Object_m_pMethTab_offset, DWORD, typeHnd_);
        SET_FIELD(arr, _wasm_ArrayBase_m_NumComponents, DWORD, elementsCount);

        return arr;
    }

    return RhpNewVariableSizeObject(typeHnd_, elementsCount);
}

EXTERN_C FCDECL2(Object*, RhpNewArrayFast, CORINFO_CLASS_HANDLE typeHnd_, INT_PTR elementsCount)
{
    // Compute overall allocation size (align(base size + (element size * elements), 4)).
    // if the element count is <= 0x10000, no overflow is possible because the component
    // size is <= 0xffff (it's an unsigned 16-bit value) and thus the product is <= 0xffff0000
    // and the base size for the worst case (32 dimensional MdArray) is less than 0xffff.

    INT_PTR memSize;
    uint16_t usComponentSize = GET_FIELD(typeHnd_, _wasm_MethodTable_m_usComponentSize_offset, uint16_t);
    // check for a big array
    if (elementsCount > 0x10000)
    {
        // if the element count is negative, it's an overflow error
        if ((int)elementsCount < 0)
            // WASM-TODO: call RhExceptionHandling_FailedAllocation with 1 indicating that we should throw OverflowException
            PORTABILITY_ASSERT("RhpNewArrayFast overflow on wasm");

        // now we know the element count is in the signed int range [0..0x7fffffff]
        // overflow in computing the total size of the array size gives an out of memory exception,
        // NOT an overflow exception
        long long possibleBigMemSize = (long long)usComponentSize*elementsCount + SZARRAY_BASE_SIZE;
        if (possibleBigMemSize > UINT_MAX)
        {
            // WASM-TODO: call RhExceptionHandling_FailedAllocation with 0 indicating that we should throw OutOfMemoryException
            PORTABILITY_ASSERT("RhpNewArrayFast out of memory on wasm");
        }

        memSize = (INT_PTR)possibleBigMemSize;
    } else {
        memSize = usComponentSize*elementsCount + SZARRAY_BASE_SIZE;
    }

    return (Object*) _WasmNewArrayFast(typeHnd_, elementsCount, ALIGN_UP(memSize, 4));
}

EXTERN_C FCDECL2(Object*, RhpNewPtrArrayFast, CORINFO_CLASS_HANDLE typeHnd_, INT_PTR size)
{
    if (size > (0x40000000 / sizeof(void*)))
        return RhpNewArrayFast(typeHnd_, size);

    INT_PTR memSize = size*sizeof(void*) + SZARRAY_BASE_SIZE;

    return (Object*) _WasmNewArrayFast(typeHnd_, size, memSize);
}
