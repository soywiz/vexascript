class MinimalHTMLElement {
  tagName: string;
  id: string;
  className: string;
  children: any[];
  dataRole: string | null;

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
    this.id = "";
    this.className = "";
    this.children = [];
    this.dataRole = null;
  }

  setAttribute(name: string, value: string): void {
    if (name === "data-role") {
      this.dataRole = value;
    }
  }

  getAttribute(name: string): string | null {
    if (name === "data-role") {
      return this.dataRole;
    }
    return null;
  }
}

class MinimalDocument {
  createElement(tagName: string): any {
    return new MinimalHTMLElement(tagName);
  }
}

export function createDocument(): any {
  return new MinimalDocument();
}
