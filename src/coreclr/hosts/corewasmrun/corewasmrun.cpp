extern "C" int coreclr_initialize(
    const char* exePath,
    const char* appDomainFriendlyName,
    int propertyCount,
    const char** propertyKeys,
    const char** propertyValues,
    void** hostHandle,
    unsigned int* domainId);

int main()
{
    coreclr_initialize("<wasm>", "corewasmrun", 0, nullptr, nullptr, nullptr, nullptr);
    // coreclr_execute_assembly();
    // coreclr_shutdown();

    return 0;
}
