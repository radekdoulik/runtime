// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace WebAssemblyInfo
{
    public class WasmRewriterBase : WasmReader
    {
        private readonly string DestinationPath;
        protected readonly BinaryWriter Writer;

        public WasmRewriterBase(WasmContext context, string source, string destination) : base(context, source)
        {
            Context = context;

            if (Context.Verbose)
                Console.WriteLine($"Writing wasm file: {destination}");

            DestinationPath = destination;
            var stream = File.Open(DestinationPath, FileMode.Create);
            Writer = new BinaryWriter(stream);
        }

        public WasmRewriterBase(WasmContext context, Stream source, long len, Stream destination) : base(context, source, len)
        {
            Context = context;
            DestinationPath = "[embedded]";
            Writer = new BinaryWriter(destination);
        }

        protected override WasmReader CreateEmbeddedReader(WasmContext context, Stream stream, long length)
        {
            return new WasmRewriterBase(context, stream, length, Writer.BaseStream);
        }

        protected override void ReadModule()
        {
            Writer.Write(MagicWasm);
            var versionPosition = Writer.BaseStream.Position;
            Writer.Write((uint)(InWitComponent ? 0x1000d : 1)); // Version

            base.ReadModule();

            var endPosition = Writer.BaseStream.Position;
            Writer.BaseStream.Position = versionPosition;
            Writer.Write((uint)Version);
            Writer.BaseStream.Position = endPosition;
        }

        protected virtual bool RewriteSection(SectionInfo _) => false;

        protected override void ReadSection(SectionInfo section)
        {
            if (RewriteSection(section))
                return;

            if (section.id == SectionId.WitCoreModule) {
                Writer.Write((byte)((uint)SectionId.WitCoreModule & 0xff));
                var sizePosition = Writer.BaseStream.Position;
                WriteU32Padded(section.size);

                var moduleStartPosition = Writer.BaseStream.Position;
                ReadWitCoreModuleSection(section);

                if (Writer.BaseStream.Position != moduleStartPosition + section.size) {
                    var endPosition = Writer.BaseStream.Position;
                    Writer.BaseStream.Position = sizePosition;
                    WriteU32Padded((uint)(endPosition - moduleStartPosition));
                    Writer.BaseStream.Position = endPosition;
                }

                return;
            }

            WriteSection(section);
        }

        private void WriteSection(SectionInfo section)
        {
            Reader.BaseStream.Seek(section.offset, SeekOrigin.Begin);
            Writer.Write(Reader.ReadBytes((int)section.size + (int)(section.begin - section.offset)));
        }

        private static uint ConstI32ExprLen(int cn) => 2 + I32Len(cn);

        // i32.const <cn>
        private void WriteConstI32Expr(int cn)
        {
            Writer.Write((byte)Opcode.I32_Const);
            WriteI32(cn);
            Writer.Write((byte)Opcode.End);
        }

        public void WriteU32(uint n)
        {
            do
            {
                byte b = (byte)(n & 0x7f);
                n >>= 7;
                if (n != 0)
                    b |= 0x80;
                Writer.Write(b);
            } while (n != 0);
        }

        public void WriteU32Padded(uint n)
        {
            int round = 0;

            do
            {
                byte b = (byte)(n & 0x7f);
                n >>= 7;
                if (n != 0 || round < 4)
                    b |= 0x80;
                Writer.Write(b);
                round++;
            } while (n != 0 || round < 5);
        }

        public static uint U32Len(uint n)
        {
            uint len = 0u;
            do
            {
                n >>= 7;
                len++;
            } while (n != 0);

            return len;
        }

        public void WriteI32(int n)
        {
            var final = false;
            do
            {
                byte b = (byte)(n & 0x7f);
                n >>= 7;

                if ((n == 0 && ((b & 0x40) == 0)) || (n == -1 && ((b & 0x40) == 0x40)))
                    final = true;
                else
                    b |= 0x80;

                Writer.Write(b);
            } while (!final);
        }

        public static uint I32Len(int n)
        {
            var final = false;
            var len = 0u;
            do
            {
                byte b = (byte)(n & 0x7f);
                n >>= 7;

                if ((n == 0 && ((b & 0x40) == 0)) || (n == -1 && ((b & 0x40) == 0x40)))
                    final = true;

                len++;
            } while (!final);

            return len;
        }

        public void WriteString(string s)
        {
            var bytes = Encoding.UTF8.GetBytes(s);
            WriteU32((uint)bytes.Length);
            Writer.Write(bytes);
        }

        public static uint StringLen(string s) => U32Len((uint)Encoding.UTF8.GetByteCount(s)) + (uint)Encoding.UTF8.GetByteCount(s);

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                Writer.Dispose();
            }

            base.Dispose(disposing);
        }
    }
}
