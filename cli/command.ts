interface CommandArgument {
  name: string;
  required: boolean;
  variadic: boolean;
  defaultValue?: unknown;
}

interface CommandOption {
  flags: string;
  longFlag: string;
  shortFlag?: string;
  name: string;
  expectsValue: boolean;
  description: string;
  defaultValue?: unknown;
}

type CommandAction0 = () => Promise<void>;
type CommandOptions = Record<string, any>;
type CommandOptionsAction = (options: CommandOptions) => Promise<void>;
type CommandStringAction = (value: string) => Promise<void>;
type CommandStringsAction = (value: string[]) => Promise<void>;
type CommandInputAction = (input: string, options: CommandOptions) => Promise<void>;

class ParsedCommandValues {
  constructor(public positional: string[], public options: CommandOptions) {}
}

function optionValueStart(value: string): number {
  let result = value.length;
  for (const delimiter of [" ", "<", "["]) {
    const index = value.indexOf(delimiter);
    if (index >= 0 && index < result) result = index;
  }
  return result;
}

function camelCaseOptionName(flag: string): string {
  const name = flag.startsWith("--") ? flag.slice(2) : flag.slice(1);
  const valueEnd = optionValueStart(name);
  const source = name.slice(0, valueEnd);
  let result = "";
  let uppercaseNext = false;
  for (const character of source) {
    if (character === "-") {
      uppercaseNext = true;
    } else if (uppercaseNext) {
      result += character.toUpperCase();
      uppercaseNext = false;
    } else {
      result += character;
    }
  }
  return result;
}

function visibleFlag(flag: string): string {
  return flag.slice(0, optionValueStart(flag));
}

function optionFromFlags(flags: string, description: string, defaultValue?: unknown): CommandOption {
  const parts = flags.split(",").map((part) => part.trim());
  const longPart = parts.find((part) => part.startsWith("--")) ?? parts[0]!;
  const shortPart = parts.find((part) => part.startsWith("-") && !part.startsWith("--"));
  return {
    flags,
    longFlag: visibleFlag(longPart),
    ...(shortPart ? { shortFlag: visibleFlag(shortPart) } : {}),
    name: camelCaseOptionName(longPart),
    expectsValue: longPart.includes("<") || longPart.includes("["),
    description,
    ...(defaultValue !== undefined ? { defaultValue } : {}),
  };
}

function argumentFromFlags(flags: string, defaultValue?: unknown): CommandArgument {
  const required = flags.startsWith("<");
  const body = flags.slice(1, -1);
  const variadic = body.endsWith("...");
  return {
    name: variadic ? body.slice(0, -3) : body,
    required,
    variadic,
    ...(defaultValue !== undefined ? { defaultValue } : {}),
  };
}

function commandUsageArgument(argument: CommandArgument): string {
  const body = `${argument.name}${argument.variadic ? "..." : ""}`;
  return argument.required ? `<${body}>` : `[${body}]`;
}

export class Command {
  private commandName = "";
  private commandDescription = "";
  private versionValue: string | null = null;
  private parent: Command | null = null;
  private readonly commands: Command[] = [];
  private readonly arguments: CommandArgument[] = [];
  private readonly options: CommandOption[] = [];
  private actionArity = -1;
  private actionCallback0: CommandAction0 = async (): Promise<void> => {};
  private optionsCallback: CommandOptionsAction = async (_options): Promise<void> => {};
  private stringCallback: CommandStringAction = async (_value): Promise<void> => {};
  private stringsCallback: CommandStringsAction = async (_values): Promise<void> => {};
  private inputCallback: CommandInputAction = async (_input, _options): Promise<void> => {};
  private acceptUnknownOptions = false;

  name(value: string): Command {
    this.commandName = value;
    return this;
  }

  description(value: string): Command {
    this.commandDescription = value;
    return this;
  }

  version(value: string): Command {
    this.versionValue = value;
    return this;
  }

  command(value: string): Command {
    const command = new Command().name(value);
    command.parent = this;
    this.commands.push(command);
    return command;
  }

  allowUnknownOption(value = true): Command {
    this.acceptUnknownOptions = value;
    return this;
  }

  argument(flags: string, _description: string, defaultValue?: unknown): Command {
    this.arguments.push(argumentFromFlags(flags, defaultValue));
    return this;
  }

  option(flags: string, description: string, defaultValue?: unknown): Command {
    this.options.push(optionFromFlags(flags, description, defaultValue));
    return this;
  }

  action0(callback: () => Promise<void>): Command {
    this.actionCallback0 = callback;
    this.actionArity = 0;
    return this;
  }

  actionOptions(callback: (options: CommandOptions) => Promise<void>): Command {
    this.optionsCallback = callback;
    this.actionArity = 1;
    return this;
  }

  actionString(callback: (value: string) => Promise<void>): Command {
    this.stringCallback = callback;
    this.actionArity = 2;
    return this;
  }

  actionStrings(callback: (value: string[]) => Promise<void>): Command {
    this.stringsCallback = callback;
    this.actionArity = 3;
    return this;
  }

  actionInput(callback: (input: string, options: CommandOptions) => Promise<void>): Command {
    this.inputCallback = callback;
    this.actionArity = 4;
    return this;
  }

  private root(): Command {
    let command: Command = this;
    while (command.parent) command = command.parent;
    return command;
  }

  private fullName(): string {
    return this.parent ? `${this.parent.fullName()} ${this.commandName}` : this.commandName;
  }

  private helpText(): string {
    const argumentUsage: string = this.arguments.map(commandUsageArgument).join(" ");
    let usageTail = "[options] [command]";
    if (this.parent) {
      const usageParts: string[] = [];
      if (this.options.length > 0) usageParts.push("[options]");
      if (argumentUsage.length > 0) usageParts.push(argumentUsage);
      usageTail = usageParts.join(" ");
    }
    const lines = [
      `Usage: ${this.fullName()}${usageTail ? ` ${usageTail}` : ""}`,
      "",
      this.commandDescription,
    ];
    if (this.arguments.length > 0) {
      lines.push("", "Arguments:");
      for (const argument of this.arguments) lines.push(`  ${commandUsageArgument(argument)}`);
    }
    const visibleOptions = [...this.options];
    if (!this.parent && this.versionValue !== undefined) {
      visibleOptions.push(optionFromFlags("-V, --version", "Output the version number"));
    }
    visibleOptions.push(optionFromFlags("-h, --help", "Display help for command"));
    if (visibleOptions.length > 0) {
      lines.push("", "Options:");
      for (const option of visibleOptions) lines.push(`  ${option.flags}  ${option.description}`);
    }
    if (this.commands.length > 0) {
      lines.push("", "Commands:");
      for (const command of this.commands) {
        const usage: string = [
          command.options.length > 0 ? "[options]" : "",
          ...command.arguments.map(commandUsageArgument),
        ].filter((part) => part.length > 0).join(" ");
        lines.push(`  ${command.commandName}${usage.length > 0 ? ` ${usage}` : ""}  ${command.commandDescription}`);
      }
      lines.push("  help [command]  Display help for command");
    }
    return `${lines.filter((line, index) => line.length > 0 || lines[index - 1] !== "").join("\n")}\n`;
  }

  outputHelp(): void {
    console.log(this.helpText().slice(0, -1));
  }

  private exitWithHelp(): never {
    this.outputHelp();
    process.exit(0);
  }

  private matchingOption(token: string): CommandOption | undefined {
    const flag = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
    return this.options.find((option) => option.longFlag === flag || option.shortFlag === flag);
  }

  private parseValues(tokens: string[]): ParsedCommandValues {
    const options: CommandOptions = {};
    for (const option of this.options) {
      if (option.defaultValue !== undefined) options[option.name] = option.defaultValue;
    }
    const positional: string[] = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (token === "--") {
        positional.push(...tokens.slice(index + 1));
        break;
      }
      if (!token.startsWith("-")) {
        positional.push(token);
        continue;
      }
      const option = this.matchingOption(token);
      if (!option) {
        if (this.acceptUnknownOptions) {
          positional.push(token);
          continue;
        }
        throw new Error(`Unknown option '${token}'`);
      }
      if (!option.expectsValue) {
        options[option.name] = true;
        continue;
      }
      const equals = token.indexOf("=");
      const value = equals >= 0 ? token.slice(equals + 1) : tokens[++index];
      if (value === undefined) throw new Error(`Option '${option.longFlag}' expects a value`);
      options[option.name] = value;
    }
    return new ParsedCommandValues(positional, options);
  }

  private validateArguments(positional: string[]): void {
    let positionalIndex = 0;
    for (const argument of this.arguments) {
      if (argument.variadic) {
        positionalIndex = positional.length;
        continue;
      }
      const value = positional[positionalIndex++] ?? argument.defaultValue;
      if (value === undefined && argument.required) {
        throw new Error(`Missing required argument '${argument.name}'`);
      }
    }
  }

  async parseAsync(argv: string[]): Promise<Command> {
    const root = this.root();
    const tokens = argv.slice(2);
    if (tokens[0] === "help") {
      const command = root.commands.find((candidate) => candidate.commandName === tokens[1]);
      (command ?? root).exitWithHelp();
    }
    if ((tokens[0] === "--version" || tokens[0] === "-V") && root.versionValue !== undefined) {
      console.log(root.versionValue);
      process.exit(0);
    }
    if (tokens.length === 0 || tokens[0] === "--help" || tokens[0] === "-h") {
      root.outputHelp();
      return this;
    }

    const command = root.commands.find((candidate) => candidate.commandName === tokens[0]);
    if (!command) throw new Error(`Unknown command '${tokens[0]}'`);
    if (tokens[1] === "--help" || tokens[1] === "-h") {
      command.exitWithHelp();
    }
    const parsed = command.parseValues(tokens.slice(1));
    if (command.actionArity < 0) return this;
    command.validateArguments(parsed.positional);
    if (command.actionArity === 0) await command.actionCallback0();
    else if (command.actionArity === 1) await command.optionsCallback(parsed.options);
    else if (command.actionArity === 2) await command.stringCallback(parsed.positional[0]!);
    else if (command.actionArity === 3) await command.stringsCallback(parsed.positional);
    else {
      await command.inputCallback(parsed.positional[0]!, parsed.options);
    }
    return this;
  }
}
