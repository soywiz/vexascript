// Constructor-only JavaScript runtime globals require `new` in JavaScript.
const bytes = new Uint8Array(7)
bytes[0] = 65
bytes[1] = 66
bytes[6] = 255

console.log(bytes.length)
console.log(`${bytes[0]},${bytes[1]},${bytes[2]},${bytes[6]}`)
console.log(bytes instanceof Uint8Array)
