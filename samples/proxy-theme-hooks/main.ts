const events = [];
function observableTheme(theme) {
const observedColors = new Proxy(theme.colors, {get(target, property, receiver) {
if (typeof property == "string") events.push("color:get:" + property + "");
return Reflect.get(target, property, receiver);
}, set(target, property, value, receiver) {
if (typeof property == "string") events.push("color:set:" + property + "=" + value + "");
return Reflect.set(target, property, value, receiver);
}});
return new Proxy({...theme, colors: observedColors}, {get(target, property, receiver) {
if (typeof property == "string") events.push("theme:get:" + property + "");
return Reflect.get(target, property, receiver);
}, set(target, property, value, receiver) {
if (typeof property == "string") events.push("theme:set:" + property + "=" + value + "");
return Reflect.set(target, property, value, receiver);
}, has(target, property) {
if (typeof property == "string") events.push("theme:has:" + property + "");
return Reflect.has(target, property);
}});
}
const theme = observableTheme({name: "light", colors: {background: "#ffffff", foreground: "#202020"}});
theme.name = "dark";
theme.colors.background = "#101010";
console.log(theme.name);
console.log(theme.colors.background);
console.log("colors" in theme);
console.log(events.join("|"));