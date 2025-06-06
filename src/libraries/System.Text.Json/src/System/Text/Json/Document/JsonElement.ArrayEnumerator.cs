// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;

namespace System.Text.Json
{
    public partial struct JsonElement
    {
        /// <summary>
        ///   An enumerable and enumerator for the contents of a JSON array.
        /// </summary>
        [DebuggerDisplay("{Current,nq}")]
        public struct ArrayEnumerator : IEnumerable<JsonElement>, IEnumerator<JsonElement>
        {
            private readonly JsonElement _target;
            private int _curIdx;
            private readonly int _endIdxOrVersion;

            internal ArrayEnumerator(JsonElement target, int currentIndex = -1)
            {
                _target = target;
                _curIdx = currentIndex;

                Debug.Assert(target.TokenType == JsonTokenType.StartArray);

                _endIdxOrVersion = target._parent.GetEndIndex(_target._idx, includeEndElement: false);
            }

            /// <inheritdoc />
            public JsonElement Current
            {
                get
                {
                    if (_curIdx < 0)
                    {
                        return default;
                    }

                    return new JsonElement(_target._parent, _curIdx);
                }
            }

            /// <summary>
            ///   Returns an enumerator that iterates through a collection.
            /// </summary>
            /// <returns>
            ///   An <see cref="ArrayEnumerator"/> value that can be used to iterate
            ///   through the array.
            /// </returns>
            public ArrayEnumerator GetEnumerator()
            {
                ArrayEnumerator ator = this;
                ator._curIdx = -1;
                return ator;
            }

            /// <inheritdoc />
            IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

            /// <inheritdoc />
            IEnumerator<JsonElement> IEnumerable<JsonElement>.GetEnumerator() => GetEnumerator();

            /// <inheritdoc />
            public void Dispose()
            {
                _curIdx = _endIdxOrVersion;
            }

            /// <inheritdoc />
            public void Reset()
            {
                _curIdx = -1;
            }

            /// <inheritdoc />
            object IEnumerator.Current => Current;

            /// <inheritdoc />
            public bool MoveNext()
            {
                if (_curIdx >= _endIdxOrVersion)
                {
                    return false;
                }

                if (_curIdx < 0)
                {
                    _curIdx = _target._idx + JsonDocument.DbRow.Size;
                }
                else
                {
                    _curIdx = _target._parent.GetEndIndex(_curIdx, includeEndElement: true);
                }

                return _curIdx < _endIdxOrVersion;
            }
        }
    }
}
