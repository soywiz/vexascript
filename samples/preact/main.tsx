import { h } from "preact";

import render from "preact-render-to-string";

function Page({ name }: { name: string }) {
    return (
        <html>
            <body>
                <h1>Hello {name}</h1>
            </body>
        </html>
    );
}

const html = "<!doctype html>" + render(<Page name="Carlos" />);
console.log(html)
