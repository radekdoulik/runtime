// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Collections.Generic;
using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;
using System.Reflection;
using System.Threading;

namespace System.Text.Json.Serialization.Metadata
{
    /// <summary>
    /// Provides JSON serialization-related metadata about a property or field defined in an object.
    /// </summary>
    [DebuggerDisplay("{DebuggerDisplay,nq}")]
    public abstract class JsonPropertyInfo
    {
        internal static readonly JsonPropertyInfo s_missingProperty = GetPropertyPlaceholder();

        internal JsonTypeInfo? DeclaringTypeInfo { get; private set; }

        /// <summary>
        /// Converter after applying CustomConverter (i.e. JsonConverterAttribute)
        /// </summary>
        internal JsonConverter EffectiveConverter
        {
            get
            {
                Debug.Assert(_effectiveConverter != null);
                return _effectiveConverter;
            }
        }

        private protected JsonConverter? _effectiveConverter;

        /// <summary>
        /// Gets or sets a custom converter override for the current property.
        /// </summary>
        /// <exception cref="InvalidOperationException">
        /// The <see cref="JsonPropertyInfo"/> instance has been locked for further modification.
        /// </exception>
        /// <remarks>
        /// It is possible to use <see cref="JsonConverterFactory"/> instances with this property.
        ///
        /// For contracts originating from <see cref="DefaultJsonTypeInfoResolver"/>, the value of
        /// <see cref="CustomConverter"/> will be mapped from <see cref="JsonConverterAttribute" /> annotations.
        /// </remarks>
        public JsonConverter? CustomConverter
        {
            get => _customConverter;
            set
            {
                VerifyMutable();
                _customConverter = value;
            }
        }

        private JsonConverter? _customConverter;

        /// <summary>
        /// Gets or sets a getter delegate for the property.
        /// </summary>
        /// <exception cref="InvalidOperationException">
        /// The <see cref="JsonPropertyInfo"/> instance has been locked for further modification.
        /// </exception>
        /// <remarks>
        /// Setting to <see langword="null"/> will result in the property being skipped on serialization.
        /// </remarks>
        public Func<object, object?>? Get
        {
            get => _untypedGet;
            set
            {
                VerifyMutable();
                SetGetter(value);
            }
        }

        /// <summary>
        /// Gets or sets a setter delegate for the property.
        /// </summary>
        /// <exception cref="InvalidOperationException">
        /// The <see cref="JsonPropertyInfo"/> instance has been locked for further modification.
        /// </exception>
        /// <remarks>
        /// Setting to <see langword="null"/> will result in the property being skipped on deserialization.
        /// </remarks>
        public Action<object, object?>? Set
        {
            get => _untypedSet;
            set
            {
                VerifyMutable();
                SetSetter(value);
                _isUserSpecifiedSetter = true;
            }
        }

        private protected Func<object, object?>? _untypedGet;
        private protected Action<object, object?>? _untypedSet;
        private bool _isUserSpecifiedSetter;

        private protected abstract void SetGetter(Delegate? getter);
        private protected abstract void SetSetter(Delegate? setter);

        /// <summary>
        /// Gets or sets a predicate deciding whether the current property value should be serialized.
        /// </summary>
        /// <exception cref="InvalidOperationException">
        /// The <see cref="JsonPropertyInfo"/> instance has been locked for further modification.
        /// </exception>
        /// <remarks>
        /// The first parameter denotes the parent object, the second parameter denotes the property value.
        ///
        /// Setting the predicate to <see langword="null"/> is equivalent to always serializing the property value.
        ///
        /// For contracts originating from <see cref="DefaultJsonTypeInfoResolver"/>,
        /// the value of <see cref="JsonIgnoreAttribute.Condition"/> will map to this predicate.
        /// </remarks>
        public Func<object, object?, bool>? ShouldSerialize
        {
            get => _shouldSerialize;
            set
            {
                VerifyMutable();
                SetShouldSerialize(value);
                // Invalidate any JsonIgnore configuration if delegate set manually by user
                _isUserSpecifiedShouldSerialize = true;
                IgnoreDefaultValuesOnWrite = false;
            }
        }

        private protected Func<object, object?, bool>? _shouldSerialize;
        private bool _isUserSpecifiedShouldSerialize;
        private protected abstract void SetShouldSerialize(Delegate? predicate);

        internal JsonIgnoreCondition? IgnoreCondition
        {
            get => _ignoreCondition;
            set
            {
                Debug.Assert(!IsConfigured);
                ConfigureIgnoreCondition(value);
                _ignoreCondition = value;
            }
        }

        private JsonIgnoreCondition? _ignoreCondition;
        private protected abstract void ConfigureIgnoreCondition(JsonIgnoreCondition? ignoreCondition);

        /// <summary>
        /// Gets or sets a custom attribute provider for the current property.
        /// </summary>
        /// <exception cref="InvalidOperationException">
        /// The <see cref="JsonPropertyInfo"/> instance has been locked for further modification.
        /// </exception>
        /// <remarks>
        /// When resolving metadata via the built-in resolvers this
        /// will be populated with the underlying <see cref="MemberInfo" /> of the serialized property or field.
        ///
        /// Setting a custom attribute provider will have no impact on the contract model,
        /// but serves as metadata for downstream contract modifiers.
        /// </remarks>
        public ICustomAttributeProvider? AttributeProvider
        {
            get
            {
                Func<ICustomAttributeProvider>? attributeProviderFactory = Volatile.Read(ref AttributeProviderFactory);
                ICustomAttributeProvider? attributeProvider = _attributeProvider;

                if (attributeProvider is null && attributeProviderFactory is not null)
                {
                    _attributeProvider = attributeProvider = attributeProviderFactory();
                    Volatile.Write(ref AttributeProviderFactory, null);
                }

                return attributeProvider;
            }
            set
            {
                VerifyMutable();

                _attributeProvider = value;
                Volatile.Write(ref AttributeProviderFactory, null);
            }
        }

        // Metadata emanating from the source generator use delayed attribute provider initialization
        // ensuring that reflection metadata resolution remains pay-for-play and is trimmable.
        internal Func<ICustomAttributeProvider>? AttributeProviderFactory;
        private ICustomAttributeProvider? _attributeProvider;

        /// <summary>
        /// Gets or sets a value indicating if the property or field should be replaced or populated during deserialization.
        /// </summary>
        /// <remarks>
        /// Initial value for this property is based on the presence of <see cref="JsonObjectCreationHandlingAttribute"/> attribute on the property.
        /// When <see langword="null"/> effective handling will be resolved based on
        /// capability of property converter to populate, containing type's <see cref="JsonTypeInfo.PreferredPropertyObjectCreationHandling"/>.
        /// and <see cref="JsonSerializerOptions.PreferredObjectCreationHandling"/> value.
        /// </remarks>
        public JsonObjectCreationHandling? ObjectCreationHandling
        {
            get => _objectCreationHandling;
            set
            {
                VerifyMutable();

                if (value != null)
                {
                    if (!JsonSerializer.IsValidCreationHandlingValue(value.Value))
                    {
                        throw new ArgumentOutOfRangeException(nameof(value));
                    }
                }

                _objectCreationHandling = value;
            }
        }

        private JsonObjectCreationHandling? _objectCreationHandling;
        internal JsonObjectCreationHandling EffectiveObjectCreationHandling { get; private set; }

        internal string? MemberName { get; set; } // Do not rename (legacy schema generation)
        internal MemberTypes MemberType { get; set; }
        internal bool IsVirtual { get; set; }

        /// <summary>
        /// Gets or sets a value indicating whether the return type of the getter is annotated as nullable.
        /// </summary>
        /// <exception cref="InvalidOperationException">
        /// The <see cref="JsonPropertyInfo"/> instance has been locked for further modification.
        ///
        /// -or-
        ///
        /// The current <see cref="PropertyType"/> is not a reference type or <see cref="Nullable{T}"/>.
        /// </exception>
        /// <remarks>
        /// Contracts originating from <see cref="DefaultJsonTypeInfoResolver"/> or <see cref="JsonSerializerContext"/>,
        /// derive the value of this property from nullable reference type annotations, including annotations
        /// from attributes such as <see cref="NotNullAttribute"/> or <see cref="MaybeNullAttribute"/>.
        ///
        /// This property has no effect on serialization unless the <see cref="JsonSerializerOptions.RespectNullableAnnotations"/>
        /// property has been enabled, in which case the serializer will reject any <see langword="null"/> values returned by the getter.
        /// </remarks>
        public bool IsGetNullable
        {
            get => _isGetNullable;
            set
            {
                VerifyMutable();

                if (value && !PropertyTypeCanBeNull)
                {
                    ThrowHelper.ThrowInvalidOperationException_PropertyTypeNotNullable(this);
                }

                _isGetNullable = value;
            }
        }

        private bool _isGetNullable;

        /// <summary>
        /// Gets or sets a value indicating whether the input type of the setter is annotated as nullable.
        /// </summary>
        /// <exception cref="InvalidOperationException">
        /// The <see cref="JsonPropertyInfo"/> instance has been locked for further modification.
        ///
        /// -or-
        ///
        /// The current <see cref="PropertyType"/> is not a reference type or <see cref="Nullable{T}"/>.
        /// </exception>
        /// <remarks>
        /// Contracts originating from <see cref="DefaultJsonTypeInfoResolver"/> or <see cref="JsonSerializerContext"/>,
        /// derive the value of this property from nullable reference type annotations, including annotations
        /// from attributes such as <see cref="AllowNullAttribute"/> or <see cref="DisallowNullAttribute"/>.
        ///
        /// This property has no effect on deserialization unless the <see cref="JsonSerializerOptions.RespectNullableAnnotations"/>
        /// property has been enabled, in which case the serializer will reject any <see langword="null"/> deserialization results.
        ///
        /// If the property has been associated with a deserialization constructor parameter,
        /// this setting reflected the nullability annotation of the parameter and not the property setter.
        /// </remarks>
        public bool IsSetNullable
        {
            get => _isSetNullable;
            set
            {
                VerifyMutable();

                if (value && !PropertyTypeCanBeNull)
                {
                    ThrowHelper.ThrowInvalidOperationException_PropertyTypeNotNullable(this);
                }

                _isSetNullable = value;
            }
        }

        private protected bool _isSetNullable;

        /// <summary>
        /// Specifies whether the current property is a special extension data property.
        /// </summary>
        /// <exception cref="InvalidOperationException">
        /// The <see cref="JsonPropertyInfo"/> instance has been locked for further modification.
        ///
        /// -or-
        ///
        /// The current <see cref="PropertyType"/> is not valid for use with extension data.
        /// </exception>
        /// <remarks>
        /// For contracts originating from <see cref="DefaultJsonTypeInfoResolver"/> or <see cref="JsonSerializerContext"/>,
        /// the value of this property will be mapped from <see cref="JsonExtensionDataAttribute"/> annotations.
        /// </remarks>
        public bool IsExtensionData
        {
            get => _isExtensionDataProperty;
            set
            {
                VerifyMutable();

                if (value && !JsonTypeInfo.IsValidExtensionDataProperty(PropertyType))
                {
                    ThrowHelper.ThrowInvalidOperationException_SerializationDataExtensionPropertyInvalid(this);
                }

                _isExtensionDataProperty = value;
            }
        }

        private bool _isExtensionDataProperty;

        /// <summary>
        /// Specifies whether the current property is required for deserialization to be successful.
        /// </summary>
        /// <exception cref="InvalidOperationException">
        /// The <see cref="JsonPropertyInfo"/> instance has been locked for further modification.
        /// </exception>
        /// <remarks>
        /// For contracts originating from <see cref="DefaultJsonTypeInfoResolver"/> or <see cref="JsonSerializerContext"/>,
        /// the value of this property will be mapped from <see cref="JsonRequiredAttribute"/> annotations.
        ///
        /// For contracts using <see cref="DefaultJsonTypeInfoResolver"/>, properties using the <see langword="required"/> keyword
        /// will also map to this setting, unless deserialization uses a SetsRequiredMembersAttribute on a constructor that populates all required properties.
        /// <see langword="required"/> keyword is currently not supported in <see cref="JsonSerializerContext"/> contracts.
        /// </remarks>
        public bool IsRequired
        {
            get => _isRequired;
            set
            {
                VerifyMutable();
                _isRequired = value;
            }
        }

        private protected bool _isRequired;

        /// <summary>
        /// Gets the constructor parameter associated with the current property.
        /// </summary>
        /// <remarks>
        /// Returns the <see cref="JsonParameterInfo"/> metadata for the parameter in the
        /// deserialization constructor that has been associated with the current property.
        ///
        /// A constructor parameter is matched to a property or field if they are of the
        /// same type and have the same name, up to case insensitivity. Each constructor
        /// parameter must be matched to exactly one property of field.
        /// </remarks>
        public JsonParameterInfo? AssociatedParameter { get; internal set; }

        internal JsonPropertyInfo(Type declaringType, Type propertyType, JsonTypeInfo? declaringTypeInfo, JsonSerializerOptions options)
        {
            Debug.Assert(declaringTypeInfo is null || declaringType.IsAssignableFrom(declaringTypeInfo.Type));

            DeclaringType = declaringType;
            PropertyType = propertyType;
            DeclaringTypeInfo = declaringTypeInfo; // null declaringTypeInfo means it's not tied yet
            Options = options;

            _isGetNullable = _isSetNullable = PropertyTypeCanBeNull;
        }

        internal static JsonPropertyInfo GetPropertyPlaceholder()
        {
            JsonPropertyInfo info = new JsonPropertyInfo<object>(typeof(object), declaringTypeInfo: null, options: null!);

            Debug.Assert(!info.IsForTypeInfo);
            Debug.Assert(!info.CanSerialize);
            Debug.Assert(!info.CanDeserialize);

            info.Name = string.Empty;

            return info;
        }

        /// <summary>
        /// Gets the declaring type of the property.
        /// </summary>
        public Type DeclaringType { get; }

        /// <summary>
        /// Gets the type of the current property.
        /// </summary>
        public Type PropertyType { get; }

        private protected void VerifyMutable()
        {
            DeclaringTypeInfo?.VerifyMutable();
        }

        internal bool IsConfigured { get; private set; }

        internal void Configure()
        {
            Debug.Assert(DeclaringTypeInfo != null);
            Debug.Assert(!IsConfigured);

            if (IsIgnored)
            {
                // Avoid configuring JsonIgnore.Always properties
                // to avoid failing on potentially unsupported types.
                CanSerialize = false;
                CanDeserialize = false;
            }
            else
            {
                _jsonTypeInfo ??= Options.GetTypeInfoInternal(PropertyType);
                _jsonTypeInfo.EnsureConfigured();

                DetermineEffectiveConverter(_jsonTypeInfo);
                DetermineNumberHandlingForProperty();
                DetermineEffectiveObjectCreationHandlingForProperty();
                DetermineSerializationCapabilities();
                DetermineIgnoreCondition();
            }

            if (IsForTypeInfo)
            {
                DetermineNumberHandlingForTypeInfo();
            }
            else
            {
                ValidateAndCachePropertyName();
            }

            if (IsRequired)
            {
                if (!CanDeserialize &&
                    !(AssociatedParameter?.IsRequiredParameter is true &&
                      Options.RespectRequiredConstructorParameters))
                {
                    ThrowHelper.ThrowInvalidOperationException_JsonPropertyRequiredAndNotDeserializable(this);
                }

                if (IsExtensionData)
                {
                    ThrowHelper.ThrowInvalidOperationException_JsonPropertyRequiredAndExtensionData(this);
                }

                Debug.Assert(!IgnoreNullTokensOnRead);
            }

            IsConfigured = true;
        }

        private protected abstract void DetermineEffectiveConverter(JsonTypeInfo jsonTypeInfo);

        [RequiresUnreferencedCode(JsonSerializer.SerializationUnreferencedCodeMessage)]
        [RequiresDynamicCode(JsonSerializer.SerializationRequiresDynamicCodeMessage)]
        internal abstract void DetermineReflectionPropertyAccessors(MemberInfo memberInfo, bool useNonPublicAccessors);

        private void ValidateAndCachePropertyName()
        {
            Debug.Assert(Name != null);

            if (Options.ReferenceHandlingStrategy is JsonKnownReferenceHandler.Preserve &&
                this is { DeclaringType.IsValueType: false, IsIgnored: false, IsExtensionData: false } &&
                Name is JsonSerializer.IdPropertyName or JsonSerializer.RefPropertyName)
            {
                // Validate potential conflicts with reference preservation metadata property names.
                // Conflicts with polymorphic type discriminators are contextual and need to be
                // handled separately by the PolymorphicTypeResolver type.

                ThrowHelper.ThrowInvalidOperationException_PropertyConflictsWithMetadataPropertyName(DeclaringType, Name);
            }

            NameAsUtf8Bytes = Encoding.UTF8.GetBytes(Name);
            EscapedNameSection = JsonHelpers.GetEscapedPropertyNameSection(NameAsUtf8Bytes, Options.Encoder);
        }

        private void DetermineIgnoreCondition()
        {
            if (_ignoreCondition != null)
            {
                // Do not apply global policy if already configured on the property level.
                return;
            }

#pragma warning disable SYSLIB0020 // JsonSerializerOptions.IgnoreNullValues is obsolete
            if (Options.IgnoreNullValues)
#pragma warning restore SYSLIB0020
            {
                Debug.Assert(Options.DefaultIgnoreCondition == JsonIgnoreCondition.Never);
                if (PropertyTypeCanBeNull)
                {
                    IgnoreNullTokensOnRead = !_isUserSpecifiedSetter && !IsRequired;
                    IgnoreDefaultValuesOnWrite = ShouldSerialize is null;
                }
            }
            else if (Options.DefaultIgnoreCondition == JsonIgnoreCondition.WhenWritingNull)
            {
                if (PropertyTypeCanBeNull)
                {
                    IgnoreDefaultValuesOnWrite = ShouldSerialize is null;
                }
            }
            else if (Options.DefaultIgnoreCondition == JsonIgnoreCondition.WhenWritingDefault)
            {
                IgnoreDefaultValuesOnWrite = ShouldSerialize is null;
            }
        }

        private void DetermineSerializationCapabilities()
        {
            Debug.Assert(EffectiveConverter != null, "Must have calculated the effective converter.");
            CanSerialize = HasGetter;
            CanDeserialize = HasSetter;

            Debug.Assert(MemberType is 0 or MemberTypes.Field or MemberTypes.Property);
            if (MemberType == 0 || _ignoreCondition != null)
            {
                // No policy to be applied if either:
                // 1. JsonPropertyInfo is a custom instance (not generated via reflection or sourcegen).
                // 2. A JsonIgnoreCondition has been specified on the property level.
                CanDeserializeOrPopulate = CanDeserialize || EffectiveObjectCreationHandling == JsonObjectCreationHandling.Populate;
                return;
            }

            if ((EffectiveConverter.ConverterStrategy & (ConverterStrategy.Enumerable | ConverterStrategy.Dictionary)) != 0)
            {
                // Properties of collections types that only have setters are not supported.
                if (Get == null && Set != null && !_isUserSpecifiedSetter)
                {
                    CanDeserialize = false;
                }
            }
            else
            {
                // For read-only properties of non-collection types, apply IgnoreReadOnlyProperties/Fields policy,
                // unless a `ShouldSerialize` predicate has been explicitly applied by the user (null or non-null).
                if (Get != null && Set == null && IgnoreReadOnlyMember && !_isUserSpecifiedShouldSerialize)
                {
                    CanSerialize = false;
                }
            }

            CanDeserializeOrPopulate = CanDeserialize || EffectiveObjectCreationHandling == JsonObjectCreationHandling.Populate;
        }

        private void DetermineNumberHandlingForTypeInfo()
        {
            Debug.Assert(DeclaringTypeInfo != null, "We should have ensured parent is assigned in JsonTypeInfo");
            Debug.Assert(!DeclaringTypeInfo.IsConfigured);

            JsonNumberHandling? declaringTypeNumberHandling = DeclaringTypeInfo.NumberHandling;

            if (declaringTypeNumberHandling != null && declaringTypeNumberHandling != JsonNumberHandling.Strict && !EffectiveConverter.IsInternalConverter)
            {
                ThrowHelper.ThrowInvalidOperationException_NumberHandlingOnPropertyInvalid(this);
            }

            if (NumberHandingIsApplicable())
            {
                // This logic is to honor JsonNumberHandlingAttribute placed on
                // custom collections e.g. public class MyNumberList : List<int>.

                // Priority 1: Get handling from the type (parent type in this case is the type itself).
                EffectiveNumberHandling = declaringTypeNumberHandling;

                // Priority 2: Get handling from JsonSerializerOptions instance.
                if (!EffectiveNumberHandling.HasValue && Options.NumberHandling != JsonNumberHandling.Strict)
                {
                    EffectiveNumberHandling = Options.NumberHandling;
                }
            }
        }

        private void DetermineNumberHandlingForProperty()
        {
            Debug.Assert(DeclaringTypeInfo != null, "We should have ensured parent is assigned in JsonTypeInfo");
            Debug.Assert(!IsConfigured, "Should not be called post-configuration.");
            Debug.Assert(_jsonTypeInfo != null, "Must have already been determined on configuration.");

            bool numberHandlingIsApplicable = NumberHandingIsApplicable();

            if (numberHandlingIsApplicable)
            {
                // Priority 1: Get handling from attribute on property/field, its parent class type or property type.
                JsonNumberHandling? handling = NumberHandling ?? DeclaringTypeInfo.NumberHandling ?? _jsonTypeInfo.NumberHandling;

                // Priority 2: Get handling from JsonSerializerOptions instance.
                if (!handling.HasValue && Options.NumberHandling != JsonNumberHandling.Strict)
                {
                    handling = Options.NumberHandling;
                }

                EffectiveNumberHandling = handling;
            }
            else if (NumberHandling.HasValue && NumberHandling != JsonNumberHandling.Strict)
            {
                ThrowHelper.ThrowInvalidOperationException_NumberHandlingOnPropertyInvalid(this);
            }
        }

        private void DetermineEffectiveObjectCreationHandlingForProperty()
        {
            Debug.Assert(EffectiveConverter != null, "Must have calculated the effective converter.");
            Debug.Assert(DeclaringTypeInfo != null, "We should have ensured parent is assigned in JsonTypeInfo");
            Debug.Assert(!IsConfigured, "Should not be called post-configuration.");

            JsonObjectCreationHandling effectiveObjectCreationHandling = JsonObjectCreationHandling.Replace;
            if (ObjectCreationHandling == null)
            {
                // Consult type-level configuration, then global configuration.
                // Ignore global configuration if we're using a parameterized constructor.
                JsonObjectCreationHandling preferredCreationHandling =
                    DeclaringTypeInfo.PreferredPropertyObjectCreationHandling
                    ?? (DeclaringTypeInfo.DetermineUsesParameterizedConstructor()
                        ? JsonObjectCreationHandling.Replace
                        : Options.PreferredObjectCreationHandling);

                bool canPopulate =
                    preferredCreationHandling == JsonObjectCreationHandling.Populate &&
                    EffectiveConverter.CanPopulate &&
                    Get != null &&
                    (!PropertyType.IsValueType || Set != null) &&
                    !DeclaringTypeInfo.SupportsPolymorphicDeserialization &&
                    !(Set == null && IgnoreReadOnlyMember);

                effectiveObjectCreationHandling = canPopulate ? JsonObjectCreationHandling.Populate : JsonObjectCreationHandling.Replace;
            }
            else if (ObjectCreationHandling == JsonObjectCreationHandling.Populate)
            {
                if (!EffectiveConverter.CanPopulate)
                {
                    ThrowHelper.ThrowInvalidOperationException_ObjectCreationHandlingPopulateNotSupportedByConverter(this);
                }

                if (Get == null)
                {
                    ThrowHelper.ThrowInvalidOperationException_ObjectCreationHandlingPropertyMustHaveAGetter(this);
                }

                if (PropertyType.IsValueType && Set == null)
                {
                    ThrowHelper.ThrowInvalidOperationException_ObjectCreationHandlingPropertyValueTypeMustHaveASetter(this);
                }

                Debug.Assert(_jsonTypeInfo != null);
                Debug.Assert(_jsonTypeInfo.IsConfigurationStarted);
                if (JsonTypeInfo.SupportsPolymorphicDeserialization)
                {
                    ThrowHelper.ThrowInvalidOperationException_ObjectCreationHandlingPropertyCannotAllowPolymorphicDeserialization(this);
                }

                if (Set == null && IgnoreReadOnlyMember)
                {
                    ThrowHelper.ThrowInvalidOperationException_ObjectCreationHandlingPropertyCannotAllowReadOnlyMember(this);
                }

                effectiveObjectCreationHandling = JsonObjectCreationHandling.Populate;
            }

            if (effectiveObjectCreationHandling is JsonObjectCreationHandling.Populate)
            {
                if (DeclaringTypeInfo.DetermineUsesParameterizedConstructor())
                {
                    ThrowHelper.ThrowNotSupportedException_ObjectCreationHandlingPropertyDoesNotSupportParameterizedConstructors();
                }

                if (Options.ReferenceHandlingStrategy != JsonKnownReferenceHandler.Unspecified)
                {
                    ThrowHelper.ThrowInvalidOperationException_ObjectCreationHandlingPropertyCannotAllowReferenceHandling();
                }
            }

            // Validation complete, commit configuration.
            EffectiveObjectCreationHandling = effectiveObjectCreationHandling;
        }

        private bool NumberHandingIsApplicable()
        {
            if (EffectiveConverter.IsInternalConverterForNumberType)
            {
                return true;
            }

            Type potentialNumberType;
            if (!EffectiveConverter.IsInternalConverter ||
                ((ConverterStrategy.Enumerable | ConverterStrategy.Dictionary) & EffectiveConverter.ConverterStrategy) == 0)
            {
                potentialNumberType = PropertyType;
            }
            else
            {
                Debug.Assert(EffectiveConverter.ElementType != null);
                potentialNumberType = EffectiveConverter.ElementType;
            }

            potentialNumberType = Nullable.GetUnderlyingType(potentialNumberType) ?? potentialNumberType;

            return potentialNumberType == typeof(byte) ||
                potentialNumberType == typeof(decimal) ||
                potentialNumberType == typeof(double) ||
                potentialNumberType == typeof(short) ||
                potentialNumberType == typeof(int) ||
                potentialNumberType == typeof(long) ||
                potentialNumberType == typeof(sbyte) ||
                potentialNumberType == typeof(float) ||
                potentialNumberType == typeof(ushort) ||
                potentialNumberType == typeof(uint) ||
                potentialNumberType == typeof(ulong) ||
#if NET
                potentialNumberType == typeof(Half) ||
#endif
#if NET
                potentialNumberType == typeof(Int128) ||
                potentialNumberType == typeof(UInt128) ||
#endif
                potentialNumberType == JsonTypeInfo.ObjectType;
        }

        /// <summary>
        /// Creates a <see cref="JsonPropertyInfo"/> instance whose type matches that of the current property.
        /// </summary>
        internal abstract void AddJsonParameterInfo(JsonParameterInfoValues parameterInfoValues);

        internal abstract bool GetMemberAndWriteJson(object obj, ref WriteStack state, Utf8JsonWriter writer);
        internal abstract bool GetMemberAndWriteJsonExtensionData(object obj, ref WriteStack state, Utf8JsonWriter writer);

        internal abstract object? GetValueAsObject(object obj);

        internal bool HasGetter => _untypedGet is not null;
        internal bool HasSetter => _untypedSet is not null;
        internal bool IgnoreNullTokensOnRead { get; private protected set; }
        internal bool IgnoreDefaultValuesOnWrite { get; private protected set; }

        internal bool IgnoreReadOnlyMember
        {
            get
            {
                Debug.Assert(MemberType == MemberTypes.Property || MemberType == MemberTypes.Field || MemberType == default);
                return MemberType switch
                {
                    MemberTypes.Property => Options.IgnoreReadOnlyProperties,
                    MemberTypes.Field => Options.IgnoreReadOnlyFields,
                    _ => false,
                };
            }
        }

        /// <summary>
        /// True if the corresponding cref="JsonTypeInfo.PropertyInfoForTypeInfo"/> is this instance.
        /// </summary>
        internal bool IsForTypeInfo { get; init; }

        // There are 3 copies of the property name:
        // 1) Name. The unescaped property name.
        // 2) NameAsUtf8Bytes. The Utf8 version of Name. Used during deserialization for property lookup.
        // 3) EscapedNameSection. The escaped version of NameAsUtf8Bytes plus the wrapping quotes and a trailing colon. Used during serialization.

        /// <summary>
        /// Gets or sets the JSON property name used when serializing the property.
        /// </summary>
        /// <exception cref="ArgumentNullException"><paramref name="value"/> is null.</exception>
        /// <exception cref="InvalidOperationException">
        /// The <see cref="JsonPropertyInfo"/> instance has been locked for further modification.
        /// </exception>
        /// <remarks>
        /// The value of <see cref="Name"/> cannot conflict with that of other <see cref="JsonPropertyInfo"/> defined in the declaring <see cref="JsonTypeInfo"/>.
        ///
        /// For contracts originating from <see cref="DefaultJsonTypeInfoResolver"/> or <see cref="JsonSerializerContext"/>,
        /// the value typically reflects the underlying .NET member name, the name derived from <see cref="JsonSerializerOptions.PropertyNamingPolicy" />,
        /// or the value specified in <see cref="JsonPropertyNameAttribute" />.
        /// </remarks>
        public string Name
        {
            get
            {
                Debug.Assert(_name != null);
                return _name;
            }
            set
            {
                VerifyMutable();

                ArgumentNullException.ThrowIfNull(value);

                _name = value;
            }
        }

        private string? _name;

        /// <summary>
        /// Utf8 version of Name.
        /// </summary>
        internal byte[] NameAsUtf8Bytes { get; private set; } = null!;

        /// <summary>
        /// The escaped name passed to the writer.
        /// </summary>
        internal byte[] EscapedNameSection { get; private set; } = null!;

        /// <summary>
        /// Gets the <see cref="JsonSerializerOptions"/> value associated with the current contract instance.
        /// </summary>
        public JsonSerializerOptions Options { get; }

        /// <summary>
        /// Gets or sets the serialization order for the current property.
        /// </summary>
        /// <exception cref="InvalidOperationException">
        /// The <see cref="JsonPropertyInfo"/> instance has been locked for further modification.
        /// </exception>
        /// <remarks>
        /// For contracts originating from <see cref="DefaultJsonTypeInfoResolver"/> or <see cref="JsonSerializerContext"/>,
        /// the value of this property will be mapped from <see cref="JsonPropertyOrderAttribute"/> annotations.
        /// </remarks>
        public int Order
        {
            get => _order;
            set
            {
                VerifyMutable();
                _order = value;
            }
        }

        private int _order;

        internal bool ReadJsonAndAddExtensionProperty(
            object obj,
            scoped ref ReadStack state,
            ref Utf8JsonReader reader)
        {
            object propValue = GetValueAsObject(obj)!;

            if (propValue is IDictionary<string, object?> dictionaryObjectValue)
            {
                if (reader.TokenType == JsonTokenType.Null)
                {
                    // A null JSON value is treated as a null object reference.
                    AddProperty(in state.Current, dictionaryObjectValue, null);
                }
                else
                {
                    JsonConverter<object> converter = GetDictionaryValueConverter<object>();
                    object value = converter.Read(ref reader, JsonTypeInfo.ObjectType, Options)!;
                    AddProperty(in state.Current, dictionaryObjectValue, value);
                }
            }
            else if (propValue is IDictionary<string, JsonElement> dictionaryElementValue)
            {
                JsonConverter<JsonElement> converter = GetDictionaryValueConverter<JsonElement>();
                JsonElement value = converter.Read(ref reader, typeof(JsonElement), Options);
                AddProperty(in state.Current, dictionaryElementValue, value);
            }
            else
            {
                // Avoid a type reference to JsonObject and its converter to support trimming.
                Debug.Assert(propValue is Nodes.JsonObject);
                EffectiveConverter.ReadElementAndSetProperty(propValue, state.Current.JsonPropertyNameAsString!, ref reader, Options, ref state);
            }

            return true;

            JsonConverter<TValue> GetDictionaryValueConverter<TValue>()
            {
                JsonTypeInfo dictionaryValueInfo =
                    JsonTypeInfo.ElementTypeInfo
                    // Slower path for non-generic types that implement IDictionary<,>.
                    // It is possible to cache this converter on JsonTypeInfo if we assume the property value
                    // will always be the same type for all instances.
                    ?? Options.GetTypeInfoInternal(typeof(TValue));

                Debug.Assert(dictionaryValueInfo is JsonTypeInfo<TValue>);
                return ((JsonTypeInfo<TValue>)dictionaryValueInfo).EffectiveConverter;
            }

            void AddProperty<TValue>(ref readonly ReadStackFrame current, IDictionary<string, TValue> d, TValue value)
            {
                string property = current.JsonPropertyNameAsString!;
                if (Options.AllowDuplicateProperties)
                {
                    d[property] = value;
                }
                else
                {
#if NET
                    if (!d.TryAdd(property, value))
#else
                    if (d.ContainsKey(property))
#endif
                    {
                        ThrowHelper.ThrowJsonException_DuplicatePropertyNotAllowed(current.JsonPropertyInfo!);
                    }

#if !NET
                    d[property] = value;
#endif
                }
            }
        }

        internal abstract bool ReadJsonAndSetMember(object obj, scoped ref ReadStack state, ref Utf8JsonReader reader);

        internal abstract bool ReadJsonAsObject(scoped ref ReadStack state, ref Utf8JsonReader reader, out object? value);

        internal bool ReadJsonExtensionDataValue(scoped ref ReadStack state, ref Utf8JsonReader reader, out object? value)
        {
            Debug.Assert(this == state.Current.JsonTypeInfo.ExtensionDataProperty);

            if (JsonTypeInfo.ElementType == JsonTypeInfo.ObjectType && reader.TokenType == JsonTokenType.Null)
            {
                value = null;
                return true;
            }

            JsonConverter<JsonElement> converter = (JsonConverter<JsonElement>)Options.GetConverterInternal(typeof(JsonElement));
            if (!converter.TryRead(ref reader, typeof(JsonElement), Options, ref state, out JsonElement jsonElement, out _))
            {
                // JsonElement is a struct that must be read in full.
                value = null;
                return false;
            }

            value = jsonElement;
            return true;
        }

        internal void EnsureChildOf(JsonTypeInfo parent)
        {
            if (DeclaringTypeInfo is null)
            {
                DeclaringTypeInfo = parent;
            }
            else if (DeclaringTypeInfo != parent)
            {
                ThrowHelper.ThrowInvalidOperationException_JsonPropertyInfoIsBoundToDifferentJsonTypeInfo(this);
            }

            DeclaringTypeInfo.ResolveMatchingParameterInfo(this);
        }

        /// <summary>
        /// Tries to get pre-populated value from the property if populating is enabled.
        /// If property value is <see langword="null"/> this method will return false.
        /// </summary>
        internal bool TryGetPrePopulatedValue(scoped ref ReadStack state)
        {
            if (EffectiveObjectCreationHandling != JsonObjectCreationHandling.Populate)
                return false;

            Debug.Assert(EffectiveConverter.CanPopulate, "Property is marked with Populate but converter cannot populate. This should have been validated in Configure");
            Debug.Assert(state.Parent.ReturnValue != null, "Parent object is null");
            Debug.Assert(!state.Current.IsPopulating, "We've called TryGetPrePopulatedValue more than once");
            object? value = Get!(state.Parent.ReturnValue);
            state.Current.ReturnValue = value;
            state.Current.IsPopulating = value != null;
            return value != null;
        }

        internal JsonTypeInfo JsonTypeInfo
        {
            get
            {
                Debug.Assert(_jsonTypeInfo?.IsConfigurationStarted == true);
                // Even though this instance has already been configured,
                // it is possible for contending threads to call the property
                // while the wider JsonTypeInfo graph is still being configured.
                // Call EnsureConfigured() to force synchronization if necessary.
                JsonTypeInfo jsonTypeInfo = _jsonTypeInfo;
                jsonTypeInfo.EnsureConfigured();
                return jsonTypeInfo;
            }
            set
            {
                _jsonTypeInfo = value;
            }
        }

        private JsonTypeInfo? _jsonTypeInfo;

        /// <summary>
        /// Returns true if <see cref="JsonTypeInfo"/> has been configured.
        /// This might be false even if <see cref="IsConfigured"/> is true
        /// in cases of recursive types or <see cref="IsIgnored"/> is true.
        /// </summary>
        internal bool IsPropertyTypeInfoConfigured => _jsonTypeInfo?.IsConfigured == true;

        /// <summary>
        /// Property was marked JsonIgnoreCondition.Always and also hasn't been configured by the user.
        /// </summary>
        internal bool IsIgnored => _ignoreCondition is JsonIgnoreCondition.Always && Get is null && Set is null;

        /// <summary>
        /// Reflects the value of <see cref="HasGetter"/> combined with any additional global ignore policies.
        /// </summary>
        internal bool CanSerialize { get; private set; }
        /// <summary>
        /// Reflects the value of <see cref="HasSetter"/> combined with any additional global ignore policies.
        /// </summary>
        internal bool CanDeserialize { get; private set; }

        /// <summary>
        /// Reflects the value can be deserialized or populated
        /// </summary>
        internal bool CanDeserializeOrPopulate { get; private set; }

        /// <summary>
        /// Relevant to source generated metadata: did the property have the <see cref="JsonIncludeAttribute"/>?
        /// </summary>
        internal bool SrcGen_HasJsonInclude { get; set; }

        /// <summary>
        /// Relevant to source generated metadata: is the property public?
        /// </summary>
        internal bool SrcGen_IsPublic { get; set; }

        /// <summary>
        /// Gets or sets the <see cref="JsonNumberHandling"/> applied to the current property.
        /// </summary>
        /// <exception cref="InvalidOperationException">
        /// The <see cref="JsonPropertyInfo"/> instance has been locked for further modification.
        /// </exception>
        /// <remarks>
        /// For contracts originating from <see cref="DefaultJsonTypeInfoResolver"/> or <see cref="JsonSerializerContext"/>,
        /// the value of this property will be mapped from <see cref="JsonNumberHandlingAttribute"/> annotations.
        /// </remarks>
        public JsonNumberHandling? NumberHandling
        {
            get => _numberHandling;
            set
            {
                VerifyMutable();
                _numberHandling = value;
            }
        }

        private JsonNumberHandling? _numberHandling;

        /// <summary>
        /// Number handling after considering options and declaring type number handling
        /// </summary>
        internal JsonNumberHandling? EffectiveNumberHandling { get; private set; }

        //  Whether the property type can be null.
        internal abstract bool PropertyTypeCanBeNull { get; }

        /// <summary>
        /// Default value used for parameterized ctor invocation.
        /// </summary>
        internal abstract object? DefaultValue { get; }

        /// <summary>
        /// Property index on the list of JsonTypeInfo properties.
        /// It is used as a unique identifier for properties.
        /// It is set just before property is configured and does not change afterward.
        /// It is not equivalent to index on the properties list
        /// </summary>
        [DebuggerBrowsable(DebuggerBrowsableState.Never)]
        internal int PropertyIndex
        {
            get
            {
                Debug.Assert(IsConfigured);
                return _propertyIndex;
            }
            set
            {
                Debug.Assert(!IsConfigured);
                _propertyIndex = value;
            }
        }

        private int _propertyIndex;

        internal bool IsOverriddenOrShadowedBy(JsonPropertyInfo other)
            => MemberName == other.MemberName && DeclaringType.IsAssignableFrom(other.DeclaringType);

        [DebuggerBrowsable(DebuggerBrowsableState.Never)]
        private string DebuggerDisplay => $"Name = {Name}, PropertyType = {PropertyType}";
    }
}
