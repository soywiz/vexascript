export class StrReader {
    private _offset: number = 0
    private _line: number = 0
    private _column: number = 0

    constructor(public str: string) {
    }

    get offset(): number {
        return this._offset
    }

    get length(): number {
        return this.str.length
    }

    get line(): number {
        return this._line
    }

    get column(): number {
        return this._column
    }

    get hasMore(): boolean {
        return this._offset < this.length
    }

    get eof(): boolean {
        return this._offset >= this.length
    }

    peek(): string {
        return this.str.charAt(this._offset)
    }

    peekCode(): number {
        return this.str.charCodeAt(this._offset)
    }

    skip(count: number = 1): number {
        const initial = this._offset
        let remaining = count
        while (remaining > 0 && this._offset < this.length) {
            const code = this.str.charCodeAt(this._offset)
            this._offset += 1
            if (code === 10) {
                this._line += 1
                this._column = 0
            } else {
                this._column += 1
            }
            remaining -= 1
        }
        return initial
    }

    read(): string {
        return this.str.charAt(this.skip(1))
    }

    readCode(): number {
        return this.str.charCodeAt(this.skip(1))
    }

    readCount(count: number): string {
        const result = this.str.substring(this.offset, this.offset + count)
        this.skip(result.length)
        return result
    }
}
