export interface NativeStandardLibraryFamilyPolicy {
  readonly owner: string;
  readonly declarationInterfaces: readonly string[];
  readonly additionalDeclarationMembers?: readonly string[];
  readonly unsupportedFamilyReason?: string;
  readonly unsupportedConstructionReason?: string;
  readonly unsupportedMembers?: readonly string[];
  readonly unsupportedMemberReasons?: Readonly<Record<string, string>>;
}

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
      "getOwnPropertySymbols",
    ],
    unsupportedMemberReasons: {
      getOwnPropertySymbols: "native generated objects currently use UTF-16 string keys and do not have symbol-key storage",
    },
  },
  { owner: "Function",
    declarationInterfaces: ["Function", "FunctionConstructor", "CallableFunction", "NewableFunction"],
    unsupportedFamilyReason: "native callable values do not yet expose the reflective Function object API",
  },
  { owner: "String", declarationInterfaces: ["String", "StringConstructor"] },
  { owner: "Boolean", declarationInterfaces: ["Boolean", "BooleanConstructor"] },
  { owner: "Number", declarationInterfaces: ["Number", "NumberConstructor"] },
  { owner: "Math", declarationInterfaces: ["Math"] },
  { owner: "Date", declarationInterfaces: ["Date", "DateConstructor"] },
  { owner: "RegExp", declarationInterfaces: ["RegExp", "RegExpConstructor"] },
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
  { owner: "ArrayBuffer", declarationInterfaces: ["ArrayBuffer", "ArrayBufferConstructor"] },
  { owner: "SharedArrayBuffer", declarationInterfaces: ["SharedArrayBuffer", "SharedArrayBufferConstructor"] },
  { owner: "DataView", declarationInterfaces: ["DataView", "DataViewConstructor"] },
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
  { owner: "Float16Array", declarationInterfaces: ["Float16Array", "Float16ArrayConstructor"] },
  { owner: "Iterator", declarationInterfaces: ["IteratorObject", "IteratorConstructor"] },
  { owner: "Performance", declarationInterfaces: ["Performance"] },
  { owner: "Error", declarationInterfaces: ["Error", "ErrorConstructor"] },
  { owner: "EvalError", declarationInterfaces: ["EvalError", "EvalErrorConstructor"] },
  { owner: "RangeError", declarationInterfaces: ["RangeError", "RangeErrorConstructor"] },
  { owner: "ReferenceError", declarationInterfaces: ["ReferenceError", "ReferenceErrorConstructor"] },
  { owner: "SyntaxError", declarationInterfaces: ["SyntaxError", "SyntaxErrorConstructor"] },
  { owner: "TypeError", declarationInterfaces: ["TypeError", "TypeErrorConstructor"] },
  { owner: "URIError", declarationInterfaces: ["URIError", "URIErrorConstructor"] },
  { owner: "AggregateError", declarationInterfaces: ["AggregateError", "AggregateErrorConstructor"] },
  { owner: "Proxy", declarationInterfaces: ["ProxyConstructor"], unsupportedFamilyReason: "native proxy traps are not implemented" },
  { owner: "Intl.Collator", declarationInterfaces: ["Collator", "CollatorConstructor"] },
  { owner: "Intl.DateTimeFormat", declarationInterfaces: ["DateTimeFormat", "DateTimeFormatConstructor"] },
  { owner: "Intl.DisplayNames", declarationInterfaces: ["DisplayNames"], additionalDeclarationMembers: ["supportedLocalesOf"] },
  { owner: "Intl.ListFormat", declarationInterfaces: ["ListFormat"], additionalDeclarationMembers: ["supportedLocalesOf"] },
  { owner: "Intl.Locale", declarationInterfaces: ["Locale"] },
  { owner: "Intl.NumberFormat", declarationInterfaces: ["NumberFormat", "NumberFormatConstructor"] },
  { owner: "Intl.PluralRules", declarationInterfaces: ["PluralRules", "PluralRulesConstructor"] },
  { owner: "Intl.RelativeTimeFormat", declarationInterfaces: ["RelativeTimeFormat"], additionalDeclarationMembers: ["supportedLocalesOf"] },
  { owner: "Intl.Segmenter", declarationInterfaces: ["Segmenter"], additionalDeclarationMembers: ["supportedLocalesOf"] },
  { owner: "Intl.Segments", declarationInterfaces: ["Segments"] },
  { owner: "Intl.DurationFormat",
    declarationInterfaces: ["DurationFormat"],
    additionalDeclarationMembers: ["supportedLocalesOf"],
  },
  { owner: "Uint8Array", declarationInterfaces: ["Uint8Array", "Uint8ArrayConstructor"] },
  { owner: "Int32Array", declarationInterfaces: ["Int32Array", "Int32ArrayConstructor"] },
  { owner: "Uint32Array", declarationInterfaces: ["Uint32Array", "Uint32ArrayConstructor"] },
  { owner: "Int8Array", declarationInterfaces: ["Int8Array", "Int8ArrayConstructor"] },
  { owner: "Uint8ClampedArray", declarationInterfaces: ["Uint8ClampedArray", "Uint8ClampedArrayConstructor"] },
  { owner: "Int16Array", declarationInterfaces: ["Int16Array", "Int16ArrayConstructor"] },
  { owner: "Uint16Array", declarationInterfaces: ["Uint16Array", "Uint16ArrayConstructor"] },
  { owner: "Float32Array", declarationInterfaces: ["Float32Array", "Float32ArrayConstructor"] },
  { owner: "Float64Array", declarationInterfaces: ["Float64Array", "Float64ArrayConstructor"] },
  { owner: "BigInt64Array", declarationInterfaces: ["BigInt64Array", "BigInt64ArrayConstructor"] },
  { owner: "BigUint64Array", declarationInterfaces: ["BigUint64Array", "BigUint64ArrayConstructor"] },
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
    getCanonicalLocales: null,
    supportedValuesOf: null,
    Collator: null,
    DateTimeFormat: null,
    DisplayNames: null,
    ListFormat: null,
    Locale: null,
    NumberFormat: null,
    PluralRules: null,
    RelativeTimeFormat: null,
    Segmenter: null,
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
  if (!member && family.unsupportedConstructionReason) return family.unsupportedConstructionReason;
  if (!member || !family.unsupportedMembers?.includes(member)) return null;
  return family.unsupportedMemberReasons?.[member]
    ?? `the native backend does not yet implement ${owner}.${member}`;
}
