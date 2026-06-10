// Constructor-only ECMAScript globals require `new` in JavaScript, even when
// the constructor is called with type arguments in VexaScript.
const scores = new Map<string, number>([["Ada", 3], ["Grace", 5]])
scores.set("Linus", 8)

console.log(scores instanceof Map)
console.log(scores.get("Grace"))
console.log([...scores.keys()].join(","))
