// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Text.Json.Schema;
using System.Text.Json.Nodes;

namespace System.Text.Json.Serialization.Converters
{
    internal sealed class JsonDocumentConverter : JsonConverter<JsonDocument?>
    {
        public override bool HandleNull => true;

        public override JsonDocument Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
            JsonDocument.ParseValue(ref reader, options.AllowDuplicateProperties);

        public override void Write(Utf8JsonWriter writer, JsonDocument? value, JsonSerializerOptions options)
        {
            if (value is null)
            {
                writer.WriteNullValue();
                return;
            }

            value.WriteTo(writer);
        }

        internal override JsonSchema? GetSchema(JsonNumberHandling _) => JsonSchema.CreateTrueSchema();
    }
}
