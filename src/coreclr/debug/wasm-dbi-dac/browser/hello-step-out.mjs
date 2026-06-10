// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

import { StepKindOut } from './host.mjs';
import { runStepCompleteSmoke } from './step-complete-smoke.mjs';

export function runSmoke() {
    return runStepCompleteSmoke({
        manifestPath: '/hello-step-out/manifest.json',
        breakpointMethodName: 'BreakHereInner',
        stepKind: StepKindOut,
        stepKindName: 'step-out',
        // Token layout for the generated program (declaration order):
        //   Main = 0x06000001, BreakHereOuter = 0x06000002, BreakHereInner = 0x06000003.
        // Step-out from BreakHereInner returns to its caller BreakHereOuter
        // (0x06000002); it must NOT remain in BreakHereInner.
        expectedLandingMethodToken: 0x06000002,
        forbiddenLandingMethodToken: 0x06000003
    });
}
