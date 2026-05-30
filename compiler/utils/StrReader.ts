export class StrReader {
    #offset: number = 0
    #line: number = 0
    #column: number = 0

    constructor(public str: string) {
    }

    get offset() {
        return this.#offset
    }

    get length() {
        return this.str.length
    }

    get line() {
        return this.#line
    }

    get column() {
        return this.#column
    }

    get hasMore() {
        return this.#offset < this.length
    }

    get eof() {
        return this.#offset >= this.length
    }

    peek() {
        return this.str.charAt(this.#offset)
    }

    peekCode() {
        return this.str.charCodeAt(this.#offset)
    }

    skip(count: number = 1) {
        const initial = this.#offset
        let remaining = count
        while (remaining > 0 && this.#offset < this.length) {
            const code = this.str.charCodeAt(this.#offset)
            this.#offset += 1
            if (code === 10) {
                this.#line += 1
                this.#column = 0
            } else {
                this.#column += 1
            }
            remaining -= 1
        }
        return initial
    }

    read() {
        return this.str.charAt(this.skip(1))
    }

    readCode() {
        return this.str.charCodeAt(this.skip(1))
    }

    readCount(count: number) {
        const result = this.str.substring(this.offset, this.offset + count)
        this.skip(result.length)
        return result
    }
}
