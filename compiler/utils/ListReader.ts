export class ListReader<T> {
    constructor(public items: T[], public offset: number = 0) {
    }

    get length() {
        return this.items.length
    }

    get eof() {
        return this.offset >= this.length
    }

    get hasMore() {
        return this.offset < this.length
    }

    peek(): T | undefined {
        return this.items[this.offset]
    }

    skip(count: number = 1) {
        this.offset += count
    }

    read(): T | undefined {
        return this.items[this.offset++]
    }
}
