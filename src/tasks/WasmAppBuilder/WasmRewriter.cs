// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Collections.Generic;
using WebAssemblyInfo;

namespace Microsoft.WebAssembly.Build.Tasks
{
    public class WasmRewriter : WasmRewriterBase
    {
        private bool producersSectionWritten;

        public WasmRewriter(WasmContext context, string sourceWasmFile, string destinationWasmFile) : base(context, sourceWasmFile, destinationWasmFile)
        {
        }

        private Dictionary<string, List<ProducerValue>> additionalProducers = new();

        public void AddProducer(string name, List<ProducerValue> values)
        {
            additionalProducers[name] = values;
        }

        protected override bool RewriteSection(SectionInfo section)
        {
            if (additionalProducers.Count > 0 && section.id == SectionId.Custom)
            {
                var start = Reader.BaseStream.Position;
                var name = Reader.ReadString();
                if (name != "producers")
                {
                    return false;
                }

                Reader.BaseStream.Position = start;

                ReadSectionContent(section);
                MergeProducers();
                WriteProducersSection();

                producersSectionWritten = true;

                return true;
            }

            return false;
        }

        private void MergeProducers()
        {
            foreach (var producer in additionalProducers)
            {
                if (producers.TryGetValue(producer.Key, out var existing))
                {
                    existing.AddRange(producer.Value);
                }
                else
                {
                    producers.Add(producer.Key, producer.Value);
                }
            }

            additionalProducers.Clear();
        }

        private uint ProducersSectionLength()
        {
            uint length = U32Len((uint)producers.Count);
            foreach (var producer in producers)
            {
                length += StringLen(producer.Key);
                length += U32Len((uint)producer.Value.Count);

                foreach (var value in producer.Value)
                {
                    length += StringLen(value.Name);
                    length += StringLen(value.Version);
                }
            }

            return length;
        }

        private void WriteProducersSection()
        {
            Writer.Write((byte)SectionId.Custom);

            uint length = ProducersSectionLength() + StringLen("producers");
            WriteU32(length);
            WriteString("producers");
            WriteU32((uint)producers.Count);

            foreach (var producer in producers)
            {
                WriteString(producer.Key);
                WriteU32((uint)producer.Value.Count);

                foreach (var value in producer.Value)
                {
                    WriteString(value.Name);
                    WriteString(value.Version);
                }
            }
        }

        public void Process()
        {
            Parse();

            if (!producersSectionWritten)
            {
                Writer.BaseStream.Position = Writer.BaseStream.Length;
                MergeProducers();
                WriteProducersSection();
            }
        }
    }
}
