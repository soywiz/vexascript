export class ListReader<T> {
    constructor(public items: T[], public offset: number = 0) {
    }

    get length(): number {
        return this.items.length
    }

    get eof(): boolean {
        return this.offset >= this.length
    }

    get hasMore(): boolean {
        return this.offset < this.length
    }

    peek(): T | undefined {
        return this.items[this.offset]
    }

    skip(count: number = 1): void {
        this.offset += count
    }

    read(): T | undefined {
        return this.items[this.offset++]
    }
}
