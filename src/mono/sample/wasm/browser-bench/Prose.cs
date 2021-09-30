// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System;
using System.IO;
using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using System.Linq;
using System.Text.Json;
using System.Net.Http;

using Microsoft.ProgramSynthesis.MultiModality.PowerApps.Repair.Context;
using Microsoft.ProgramSynthesis.MultiModality.PowerApps.Repair;
using System.Threading.Tasks;

namespace Sample
{
    class ProseTask : BenchTask
    {
        public override string Name => "Prose";
        Measurement[] measurements;

        public ProseTask()
        {
            var json = File.ReadAllText("powerapps.json");
            formulas = JsonSerializer.Deserialize<List<Formula>>(json).ToArray();
            Console.WriteLine($"formulas count: {formulas.Length}");

            List<RepairMeasurement> ms = new();
            foreach (var formula in formulas)
            {
                ms.Add(new RepairMeasurement(formula));
            }

            measurements = ms.ToArray();
        }

        public override Measurement[] Measurements
        {
            get
            {
                return measurements;
            }
        }

        class LogResult
        {
            public LogResult(string benchmarkName, double benchmarkTime)
            {
                BenchmarkName = benchmarkName;
                Time = benchmarkTime;
                TimedOut = false;
                Failed = false;
            }

            public string BenchmarkName { get; set; }
            public double Time { get; set; }
            public bool TimedOut { get; set; }
            public bool Failed { get; set; }
        }

        public override void Finish()
        {
            Console.WriteLine("finish");
            List<LogResult> logResults = new();
            foreach (var measurement in (RepairMeasurement[])measurements)
            {
                logResults.Add(new(measurement.Formula.Name, measurement.Time));
            }
            Console.WriteLine($"results: {logResults.Count()}");
            var json = JsonSerializer.Serialize<List<LogResult>>(logResults);
            Console.WriteLine($"json: {json}");
            File.WriteAllText("/results.json", json);
        }

        class Formula
        {
            public string Name { get; set; }
            public string Input { get; set; }
            public string Expected { get; set; }
        }

        Formula[] formulas;

        public override void Initialize()
        {
        }

        class RepairMeasurement : BenchTask.Measurement
        {
            public Formula Formula { get; private set; }
            List<Result> results = new();

            public RepairMeasurement(Formula formula) => Formula = formula;
            public override string Name => Formula.Name;
            public override int InitialSamples => 10;

            public override void RunStep()
            {
                var ctx = new SimpleContext(isBehavior: true, allowsNavigation: true);
                var repairer = new FormulaRepairer(ctx);
                //try {
                IReadOnlyList<string> repairs = repairer.RepairSyntax(Formula.Input, k: 5 /*, cancel: cancellationToken */);
                if (repairs.Count == 0)
                    throw new Exception("Repair failed");
                //Console.WriteLine(repairs.First());
            }

            public override Task AfterBatch(Result result)
            {
                results.Add(result);
                return Task.CompletedTask;
            }

            public double Time
            {
                get
                {
                    double time = double.MaxValue;
                    foreach (var res in results)
                        time = Math.Min(time, ((double)res.span.TotalMilliseconds) / res.steps);

                    return time;
                }
            }
        }
    }
}
