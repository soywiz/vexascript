/**
 * Integration fixture with TypeScript .d.ts syntax currently supported by the parser.
 */
declare function moment(inp?: moment.MomentInput, strict?: boolean): moment.Moment;

declare namespace moment {
}

export = moment;
