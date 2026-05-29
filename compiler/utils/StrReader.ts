export class StrReader {
    constructor(public str: string, public offset: number = 0) {
    }

    get length() {
        return this.str.length
    }

    get hasMore() {
        return this.offset < this.length
    }

    get eof() {
        return this.offset >= this.length
    }

    peek() {
        return this.str.charAt(this.offset)
    }

    peekCode() {
        return this.str.charCodeAt(this.offset)
    }

    skip(count: number = 1) {
        this.offset += count
    }

    read() {
        return this.str.charAt(this.offset++)
    }

    readCode() {
        return this.str.charCodeAt(this.offset++)
    }

    readCount(count: number) {
        const result = this.str.substr(this.offset, count)
        this.offset += result.length
        return result
    }
}
