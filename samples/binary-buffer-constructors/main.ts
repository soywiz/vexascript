// Constructor-only ECMAScript binary-buffer globals require `new` in JavaScript.
const buffer = new ArrayBuffer(4)
const view = new DataView(buffer)
view.setUint16(0, 0x1234)
view.setUint16(2, 0xabcd)

const bytes = new Uint8Array(buffer)
const byteSet = new Set<number>([bytes[0], bytes[1], bytes[2], bytes[3]])
const metadataKey = { kind: "buffer" }
const metadata = new WeakMap<object, string>([[metadataKey, "ready"]])

console.log(buffer.byteLength)
console.log(`${view.getUint8(0)},${view.getUint8(1)},${view.getUint8(2)},${view.getUint8(3)}`)
console.log([...byteSet].join(","))
console.log(metadata.get(metadataKey))
console.log(view instanceof DataView)
