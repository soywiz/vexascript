import { Application, Graphics, View, Text, TextStyle, type Point, type Container } from "pixi.js"

const width = 480
const height = 320
const centerX = width / 2
const centerY = height / 2

const app = new Application()
await app.init({
    width,
    height,
    resolution: 1,
    antialias: true,     // Enable antialiasing
})
app.renderer.resize(width, height)
const stage = app.stage

document.body.setAttribute("style", "margin:0;display:grid;place-items:center;min-height:100vh;background:#f3efe2;")
document.body.appendChild(app.canvas)

const badge = new Graphics()
badge.beginFill(0xff6b35)
badge.drawRoundedRect(-110, -64, 220, 128, 28)
badge.endFill()
badge.x = centerX
badge.y = centerY - 16
stage.addChild(badge)

const orb = new Graphics()
orb.beginFill(0x004e89)
orb.circle(0, 0, 28)
orb.endFill()
orb.x = centerX
orb.y = centerY - 16
stage.addChild(orb)

const label = new Text()
label.text = "Hello PIXI from VexaScript"
label.style = new TextStyle({
    fill: 0x1f2933,
    fontSize: 24,
    fontFamily: "Avenir Next, Arial, sans-serif",
    fontWeight: "700"
})
label.anchor = 0.5
label.x = centerX
label.y = height - 54
stage.addChild(label)

var drift: number = 0
app.ticker.add(() => {
    drift++
    orb.x = centerX + Math.cos(drift * 0.02) * 56
})

console.log("pixi-ready")
console.log(app.ticker.FPS)
