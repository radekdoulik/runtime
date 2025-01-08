// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.IO;
using System.Collections.Generic;
using Microsoft.Build.Framework;
using WebAssemblyInfo;

namespace Microsoft.WebAssembly.Build.Tasks
{
    public class ProducersSection : Microsoft.Build.Utilities.Task
    {
        [Required]
        public string? SourceWasmFile { get; set; }
        [Required]
        public string? DestinationWasmFile { get; set; }

        [Required]
        public ITaskItem[]? Producers { get; set; }

        public override bool Execute()
        {
            if (string.IsNullOrEmpty(SourceWasmFile) || !File.Exists(SourceWasmFile))
            {
                Log.LogError("SourceWasmFile is required and should exist.");
                return false;
            }

            if (string.IsNullOrEmpty(DestinationWasmFile))
            {
                Log.LogError("DestinationWasmFile is required.");
                return false;
            }

            if (Producers == null || Producers.Length == 0)
            {
                Log.LogError("Producers is required.");
                return false;
            }

            using var rewriter = new WasmRewriter(new WasmContext(), SourceWasmFile, DestinationWasmFile);
            var producerValues = new List<ProducerValue>();

            foreach (var producer in Producers)
            {
                var name = producer.GetMetadata("Identity");
                var values = producer.GetMetadata("Values");

                if (values == null)
                {
                    Log.LogError("Producers Values are required.");
                    return false;
                }

                foreach (var value in values.Split(';'))
                {
                    var fields = value.Split(',');
                    if (fields.Length != 2)
                    {
                        Log.LogError("Producers Values should be in the format of 'Name,Version'.");
                        return false;
                    }

                    producerValues.Add(new ProducerValue { Name = fields[0], Version = fields[1] });
                }
                rewriter.AddProducer(name, producerValues);
            }

            rewriter.Process();

            return true;
        }
    }
}
