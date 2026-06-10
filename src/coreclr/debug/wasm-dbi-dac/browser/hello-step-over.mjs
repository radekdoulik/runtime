// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

import { StepKindOver } from './host.mjs';
import { runStepCompleteSmoke } from './step-complete-smoke.mjs';

export function runSmoke() {
    return runStepCompleteSmoke({
        manifestPath: '/hello-step-over/manifest.json',
        breakpointMethodName: 'BreakHere',
        stepKind: StepKindOver,
        stepKindName: 'step-over',
        // Token layout for the generated program (declaration order):
        //   Main = 0x06000001, BreakHere = 0x06000002, SomeOtherMethod = 0x06000003.
        // Step-over from BreakHere skips the SomeOtherMethod() call and lands
        // back in BreakHere (0x06000002); it must NOT land in SomeOtherMethod.
        expectedLandingMethodToken: 0x06000002,
        forbiddenLandingMethodToken: 0x06000003
    });
}
