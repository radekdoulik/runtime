// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

import { StepKindInto } from './host.mjs';
import { runStepCompleteSmoke } from './step-complete-smoke.mjs';

export function runSmoke() {
    return runStepCompleteSmoke({
        manifestPath: '/hello-step/manifest.json',
        breakpointMethodName: 'BreakHere',
        stepKind: StepKindInto,
        stepKindName: 'step-into',
        expectedLandingMethodToken: 0x06000002,
        forbiddenLandingMethodToken: 0,
        // Generic interpreter step-into reports the tracked one-shot request
        // offset, while the runtime hit count verifies that execution advanced.
        requireOffsetAdvance: false
    });
}
