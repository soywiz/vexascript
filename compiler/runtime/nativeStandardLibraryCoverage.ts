export interface NativeStandardLibraryFamilyPolicy {
  readonly owner: string;
  readonly declarationInterfaces: readonly string[];
  readonly additionalDeclarationMembers?: readonly string[];
  readonly unsupportedFamilyReason?: string;
  readonly unsupportedMembers?: readonly string[];
}

const unsupportedTypedArrayReason =
  "the native backend does not yet provide this typed-array representation";

/**
 * Native ECMAScript coverage policy for the executable language smoke.
 *
 * A member absent from this policy must have an execution label in
 * samples/native-language-smoke/standard-library.vx. Keeping the exceptions
 * here makes declaration/runtime drift fail in a fast TypeScript test instead
 * of much later while compiling a self-hosted C++ generation.
 */
export const NATIVE_STANDARD_LIBRARY_FAMILIES: readonly NativeStandardLibraryFamilyPolicy[] = [
  { owner: "Object",
    declarationInterfaces: ["Object", "ObjectConstructor"],
    unsupportedMembers: [
      "assign", "constructor", "create", "defineProperties", "freeze",
      "getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "getOwnPropertyNames",
      "getOwnPropertySymbols", "getPrototypeOf", "hasOwn", "hasOwnProperty", "is",
      "isExtensible", "isFrozen", "isPrototypeOf", "isSealed", "preventExtensions",
      "propertyIsEnumerable", "seal", "setPrototypeOf", "toLocaleString", "toString", "valueOf",
    ],
  },
  { owner: "Function",
    declarationInterfaces: ["Function", "FunctionConstructor", "CallableFunction", "NewableFunction"],
    unsupportedFamilyReason: "native callable values do not yet expose the reflective Function object API",
  },
  { owner: "String",
    declarationInterfaces: ["String", "StringConstructor"],
    unsupportedMembers: [
      "anchor", "big", "blink", "bold", "fixed", "fontcolor", "fontsize", "fromCodePoint",
      "italics", "link", "localeCompare", "match", "matchAll", "normalize", "padEnd", "padStart",
      "raw", "search", "small", "strike", "sub", "substr", "sup",
    ],
  },
  { owner: "Boolean", declarationInterfaces: ["Boolean", "BooleanConstructor"] },
  { owner: "Number",
    declarationInterfaces: ["Number", "NumberConstructor"],
    unsupportedMembers: [
      "EPSILON", "MAX_SAFE_INTEGER", "MAX_VALUE", "MIN_SAFE_INTEGER", "MIN_VALUE",
      "NEGATIVE_INFINITY", "NaN", "POSITIVE_INFINITY", "isSafeInteger", "parseFloat", "parseInt",
      "toExponential", "toPrecision",
    ],
  },
  { owner: "Math", declarationInterfaces: ["Math"] },
  { owner: "Date",
    declarationInterfaces: ["Date", "DateConstructor"],
    unsupportedMembers: [
      "UTC", "getDate", "getDay", "getFullYear", "getHours", "getMilliseconds", "getMinutes",
      "getMonth", "getSeconds", "getTimezoneOffset", "setDate", "setFullYear", "setHours",
      "setMilliseconds", "setMinutes", "setMonth", "setSeconds", "setTime", "setUTCDate",
      "setUTCFullYear", "setUTCHours", "setUTCMilliseconds", "setUTCMinutes", "setUTCMonth",
      "setUTCSeconds", "toDateString", "toLocaleDateString", "toLocaleString", "toLocaleTimeString",
      "toTimeString", "toUTCString",
    ],
  },
  { owner: "RegExp",
    declarationInterfaces: ["RegExp", "RegExpConstructor"],
    unsupportedMembers: [
      "$&", "$'", "$+", "$1", "$2", "$3", "$4", "$5", "$6", "$7", "$8", "$9", "$_", "$`",
      "compile", "input", "lastMatch", "lastParen", "leftContext", "rightContext",
    ],
  },
  { owner: "JSON", declarationInterfaces: ["JSON"] },
  { owner: "Array", declarationInterfaces: ["Array", "ArrayConstructor"] },
  { owner: "Map", declarationInterfaces: ["Map", "MapConstructor"] },
  { owner: "WeakMap", declarationInterfaces: ["WeakMap", "WeakMapConstructor"] },
  { owner: "Set", declarationInterfaces: ["Set", "SetConstructor"] },
  { owner: "WeakSet", declarationInterfaces: ["WeakSet", "WeakSetConstructor"] },
  { owner: "Symbol",
    declarationInterfaces: ["Symbol", "SymbolConstructor"],
    unsupportedFamilyReason: "native symbol identity and the global symbol registry are not implemented",
  },
  { owner: "Promise", declarationInterfaces: ["Promise", "PromiseConstructor"] },
  { owner: "ArrayBuffer",
    declarationInterfaces: ["ArrayBuffer", "ArrayBufferConstructor"],
    unsupportedMembers: ["resize", "transfer", "transferToFixedLength"],
  },
  { owner: "SharedArrayBuffer", declarationInterfaces: ["SharedArrayBuffer", "SharedArrayBufferConstructor"] },
  { owner: "DataView",
    declarationInterfaces: ["DataView", "DataViewConstructor"],
    unsupportedMembers: ["getBigInt64", "getBigUint64", "getFloat16", "setBigInt64", "setBigUint64", "setFloat16"],
  },
  { owner: "Atomics", declarationInterfaces: ["Atomics"] },
  { owner: "BigInt", declarationInterfaces: ["BigInt", "BigIntConstructor"] },
  { owner: "WeakRef",
    declarationInterfaces: ["WeakRef", "WeakRefConstructor"],
    unsupportedFamilyReason: "native weak-reference observation is not implemented",
  },
  { owner: "FinalizationRegistry",
    declarationInterfaces: ["FinalizationRegistry", "FinalizationRegistryConstructor"],
    unsupportedFamilyReason: "native finalization callbacks are not implemented",
  },
  { owner: "Float16Array",
    declarationInterfaces: ["Float16Array", "Float16ArrayConstructor"],
    unsupportedMembers: [
      "BYTES_PER_ELEMENT", "at", "buffer", "byteLength", "byteOffset", "copyWithin", "entries", "every",
      "fill", "filter", "find", "findIndex", "findLast", "findLastIndex", "forEach", "includes", "indexOf",
      "keys", "lastIndexOf", "map", "reduce", "reduceRight", "reverse", "set", "slice",
      "some", "sort", "subarray", "toLocaleString", "toReversed", "toSorted", "toString", "valueOf", "values", "with",
    ],
  },
  { owner: "Iterator", declarationInterfaces: ["IteratorObject", "IteratorConstructor"] },
  { owner: "Performance", declarationInterfaces: ["Performance"] },
  { owner: "Error",
    declarationInterfaces: ["Error", "ErrorConstructor"],
    unsupportedMembers: ["cause", "name", "stack"],
  },
  { owner: "EvalError", declarationInterfaces: ["EvalError", "EvalErrorConstructor"], unsupportedFamilyReason: "the native EvalError class is not implemented" },
  { owner: "RangeError", declarationInterfaces: ["RangeError", "RangeErrorConstructor"] },
  { owner: "ReferenceError", declarationInterfaces: ["ReferenceError", "ReferenceErrorConstructor"], unsupportedFamilyReason: "the native ReferenceError class is not implemented" },
  { owner: "SyntaxError", declarationInterfaces: ["SyntaxError", "SyntaxErrorConstructor"] },
  { owner: "TypeError", declarationInterfaces: ["TypeError", "TypeErrorConstructor"] },
  { owner: "URIError", declarationInterfaces: ["URIError", "URIErrorConstructor"], unsupportedFamilyReason: "the native URIError class is not implemented" },
  { owner: "AggregateError", declarationInterfaces: ["AggregateError", "AggregateErrorConstructor"], unsupportedFamilyReason: "the native AggregateError class is not implemented" },
  { owner: "Proxy", declarationInterfaces: ["ProxyConstructor"], unsupportedFamilyReason: "native proxy traps are not implemented" },
  { owner: "Intl.DurationFormat",
    declarationInterfaces: ["DurationFormat"],
    additionalDeclarationMembers: ["supportedLocalesOf"],
    unsupportedMembers: ["supportedLocalesOf"],
  },
  { owner: "Uint8Array",
    declarationInterfaces: ["Uint8Array", "Uint8ArrayConstructor"],
    unsupportedMembers: [
      "BYTES_PER_ELEMENT", "at", "copyWithin", "entries", "every", "fill", "filter", "find", "findIndex",
      "findLast", "findLastIndex", "forEach", "from", "includes", "indexOf", "join", "keys", "lastIndexOf",
      "map", "of", "reduce", "reduceRight", "reverse", "set", "slice", "some", "sort", "subarray",
      "toLocaleString", "toReversed", "toSorted", "toString", "valueOf", "values", "with",
    ],
  },
  { owner: "Int32Array",
    declarationInterfaces: ["Int32Array", "Int32ArrayConstructor"],
    unsupportedMembers: [
      "BYTES_PER_ELEMENT", "at", "copyWithin", "entries", "every", "fill", "filter", "find", "findIndex",
      "findLast", "findLastIndex", "forEach", "from", "includes", "indexOf", "join", "keys", "lastIndexOf",
      "map", "of", "reduce", "reduceRight", "reverse", "set", "slice", "some", "sort", "subarray",
      "toLocaleString", "toReversed", "toSorted", "toString", "valueOf", "values", "with",
    ],
  },
  { owner: "Uint32Array",
    declarationInterfaces: ["Uint32Array", "Uint32ArrayConstructor"],
    unsupportedMembers: [
      "BYTES_PER_ELEMENT", "at", "copyWithin", "entries", "every", "fill", "filter", "find", "findIndex",
      "findLast", "findLastIndex", "forEach", "from", "includes", "indexOf", "join", "keys", "lastIndexOf",
      "map", "of", "reduce", "reduceRight", "reverse", "set", "slice", "some", "sort", "subarray",
      "toLocaleString", "toReversed", "toSorted", "toString", "valueOf", "values", "with",
    ],
  },
  { owner: "Int8Array", declarationInterfaces: ["Int8Array", "Int8ArrayConstructor"], unsupportedFamilyReason: unsupportedTypedArrayReason },
  { owner: "Uint8ClampedArray", declarationInterfaces: ["Uint8ClampedArray", "Uint8ClampedArrayConstructor"], unsupportedFamilyReason: unsupportedTypedArrayReason },
  { owner: "Int16Array", declarationInterfaces: ["Int16Array", "Int16ArrayConstructor"], unsupportedFamilyReason: unsupportedTypedArrayReason },
  { owner: "Uint16Array", declarationInterfaces: ["Uint16Array", "Uint16ArrayConstructor"], unsupportedFamilyReason: unsupportedTypedArrayReason },
  { owner: "Float32Array", declarationInterfaces: ["Float32Array", "Float32ArrayConstructor"], unsupportedFamilyReason: unsupportedTypedArrayReason },
  { owner: "Float64Array", declarationInterfaces: ["Float64Array", "Float64ArrayConstructor"], unsupportedFamilyReason: unsupportedTypedArrayReason },
  { owner: "BigInt64Array", declarationInterfaces: ["BigInt64Array", "BigInt64ArrayConstructor"], unsupportedFamilyReason: unsupportedTypedArrayReason },
  { owner: "BigUint64Array", declarationInterfaces: ["BigUint64Array", "BigUint64ArrayConstructor"], unsupportedFamilyReason: unsupportedTypedArrayReason },
];

export const NATIVE_STANDARD_LIBRARY_GLOBAL_FUNCTIONS: Readonly<Record<string, string | null>> = {
  eval: "native dynamic source evaluation is not implemented",
  parseInt: null,
  parseFloat: null,
  isNaN: null,
  isFinite: null,
  decodeURI: null,
  decodeURIComponent: null,
  encodeURI: null,
  encodeURIComponent: null,
  escape: null,
  unescape: null,
};

export const NATIVE_STANDARD_LIBRARY_NAMESPACE_POLICY: Readonly<Record<string, Readonly<Record<string, string | null>>>> = {
  Reflect: {
    apply: "the native reflection API is not implemented",
    construct: "the native reflection API is not implemented",
    defineProperty: "the native reflection API is not implemented",
    deleteProperty: "the native reflection API is not implemented",
    get: "the native reflection API is not implemented",
    getOwnPropertyDescriptor: "the native reflection API is not implemented",
    getPrototypeOf: "the native reflection API is not implemented",
    has: "the native reflection API is not implemented",
    isExtensible: "the native reflection API is not implemented",
    ownKeys: "the native reflection API is not implemented",
    preventExtensions: "the native reflection API is not implemented",
    set: "the native reflection API is not implemented",
    setPrototypeOf: "the native reflection API is not implemented",
  },
  Intl: {
    getCanonicalLocales: "the native Intl locale registry is not implemented",
    supportedValuesOf: "the native Intl locale registry is not implemented",
    Collator: "the native Intl.Collator object is not implemented",
    DateTimeFormat: "the native Intl.DateTimeFormat object is not implemented",
    DisplayNames: "the native Intl.DisplayNames object is not implemented",
    ListFormat: "the native Intl.ListFormat object is not implemented",
    Locale: "the native Intl.Locale object is not implemented",
    NumberFormat: "the native Intl.NumberFormat object is not implemented",
    PluralRules: "the native Intl.PluralRules object is not implemented",
    RelativeTimeFormat: "the native Intl.RelativeTimeFormat object is not implemented",
    Segmenter: "the native Intl.Segmenter object is not implemented",
    DurationFormat: null,
  },
};

function isObjectPrototypeKey(key: string): boolean {
  return [
    "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__", "__proto__",
    "constructor", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString",
    "toString", "valueOf",
  ].includes(key);
}

function nativeStandardLibraryFamilyPolicy(owner: string): NativeStandardLibraryFamilyPolicy | null {
  for (const policy of NATIVE_STANDARD_LIBRARY_FAMILIES) {
    if (policy.owner === owner) return policy;
  }
  return null;
}

export function isNativeStandardLibraryFamily(owner: string): boolean {
  return nativeStandardLibraryFamilyPolicy(owner) !== null;
}

function nativeStandardLibraryGlobalReason(owner: string): string | null {
  for (const [candidate, reason] of Object.entries(NATIVE_STANDARD_LIBRARY_GLOBAL_FUNCTIONS)) {
    if (candidate === owner) return reason;
  }
  return null;
}

function nativeStandardLibraryNamespaceReason(owner: string, member: string): string | null {
  for (const [candidateOwner, policy] of Object.entries(NATIVE_STANDARD_LIBRARY_NAMESPACE_POLICY)) {
    if (candidateOwner !== owner) continue;
    for (const [candidateMember, reason] of Object.entries(policy)) {
      if (candidateMember === member) return reason;
    }
  }
  return null;
}

export function nativeStandardLibraryUnsupportedReason(owner: string, member?: string): string | null {
  if (isObjectPrototypeKey(owner)) return null;
  if (!member) {
    const globalReason = nativeStandardLibraryGlobalReason(owner);
    if (globalReason) return globalReason;
  }
  if (member && !isObjectPrototypeKey(member)) {
    const namespaceReason = nativeStandardLibraryNamespaceReason(owner, member);
    if (namespaceReason) return namespaceReason;
  }
  const family = nativeStandardLibraryFamilyPolicy(owner);
  if (!family) return null;
  if (family.unsupportedFamilyReason) return family.unsupportedFamilyReason;
  return member && family.unsupportedMembers?.includes(member)
    ? `the native backend does not yet implement ${owner}.${member}`
    : null;
}
